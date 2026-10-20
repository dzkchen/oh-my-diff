use aws_lc_rs::aead;
use aws_lc_rs::agreement;
use aws_lc_rs::cipher;
use aws_lc_rs::digest;
use aws_lc_rs::encoding::AsBigEndian;
use aws_lc_rs::encoding::AsDer;
use aws_lc_rs::encoding::Curve25519SeedBin;
use aws_lc_rs::encoding::EcPrivateKeyBin;
use aws_lc_rs::encoding::Pkcs8V1Der;
use aws_lc_rs::encoding::PublicKeyX509Der;
use aws_lc_rs::hkdf;
use aws_lc_rs::hmac;
use aws_lc_rs::iv::FixedLength;
use aws_lc_rs::key_wrap;
use aws_lc_rs::key_wrap::KeyWrap;
use aws_lc_rs::pbkdf2;
use aws_lc_rs::rand;
use aws_lc_rs::rsa;
use aws_lc_rs::signature;
use aws_lc_rs::signature::KeyPair as _;
use base64::Engine as _;
use serde_json::Value;
use serde_json::json;
use std::cell::RefCell;
use std::num::NonZeroU32;

type Failure = (&'static str, String);
type Outcome<T> = Result<T, Failure>;

const MAX_KEY_BITS: u64 = 8 << 20;

const ALGORITHMS: [&str; 18] = [
    "RSASSA-PKCS1-v1_5",
    "RSA-PSS",
    "RSA-OAEP",
    "ECDSA",
    "ECDH",
    "Ed25519",
    "X25519",
    "AES-CTR",
    "AES-CBC",
    "AES-GCM",
    "AES-KW",
    "HMAC",
    "SHA-1",
    "SHA-256",
    "SHA-384",
    "SHA-512",
    "HKDF",
    "PBKDF2",
];
const USAGES: [&str; 8] = [
    "encrypt",
    "decrypt",
    "sign",
    "verify",
    "deriveKey",
    "deriveBits",
    "wrapKey",
    "unwrapKey",
];
const EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const ED25519_OID: &[u8] = &[0x2b, 0x65, 0x70];
const X25519_OID: &[u8] = &[0x2b, 0x65, 0x6e];

#[derive(Clone, Copy, PartialEq)]
enum Curve {
    P256,
    P384,
    P521,
}

#[derive(Clone, Copy, PartialEq)]
enum Okp {
    Ed25519,
    X25519,
}

#[derive(Clone)]
enum Material {
    Secret(Vec<u8>),
    Ec {
        curve: Curve,
        private: Option<Vec<u8>>,
        public: Vec<u8>,
    },
    Okp {
        curve: Okp,
        private: Option<Vec<u8>>,
        public: Vec<u8>,
    },
    Rsa {
        private: Option<Vec<u8>>,
        n: Vec<u8>,
        e: Vec<u8>,
    },
}

#[derive(Clone)]
struct Key {
    kind: &'static str,
    algorithm: Value,
    extractable: bool,
    usages: Vec<String>,
    material: Material,
}

thread_local! {
    static KEYS: RefCell<Vec<Key>> = const { RefCell::new(Vec::new()) };
}

fn fail<T>(name: &'static str, message: impl Into<String>) -> Outcome<T> {
    Err((name, message.into()))
}

fn operation<T>(result: Result<T, impl Sized>) -> Outcome<T> {
    result.or_else(|_| {
        fail(
            "OperationError",
            "The operation failed for an operation-specific reason",
        )
    })
}

fn data<T>(result: Result<T, impl Sized>) -> Outcome<T> {
    result.or_else(|_| fail("DataError", "Invalid keyData"))
}

/// The `crypto` host object for one callback; keys it hands out are valid only within that callback.
pub fn bridge<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let object = v8::Object::new(scope);
    let functions = [
        ("random", v8::Function::new(scope, random)),
        ("uuid", v8::Function::new(scope, uuid)),
        ("subtle", v8::Function::new(scope, subtle)),
    ];
    for (name, function) in functions {
        let key = v8::String::new(scope, name).unwrap_or_else(|| v8::String::empty(scope));
        if let Some(function) = function {
            object.set(scope, key.into(), function.into());
        }
    }
    object
}

pub fn forget() {
    KEYS.with_borrow_mut(Vec::clear);
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

fn random(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let length = args.get(0).uint32_value(scope).unwrap_or(0).min(65_536) as usize;
    let mut bytes = vec![0; length];
    if getrandom::fill(&mut bytes).is_ok()
        && let Some(text) = v8::String::new(scope, &latin1(&bytes))
    {
        reply.set(text.into());
    }
}

fn uuid(
    scope: &mut v8::PinScope,
    _: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return;
    }
    let text = uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string();
    if let Some(text) = v8::String::new(scope, &text) {
        reply.set(text.into());
    }
}

fn subtle(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _: v8::ReturnValue<v8::Value>,
) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let payload = args.get(1).to_rust_string_lossy(scope);
    let Ok(settle) = v8::Local::<v8::Function>::try_from(args.get(2)) else {
        return;
    };
    let outcome = serde_json::from_str::<Vec<Value>>(&payload)
        .or_else(|error| fail("TypeError", error.to_string()))
        .and_then(|arguments| call(&name, &arguments));
    let reply = match outcome {
        Ok(value) => json!({ "value": value }),
        Err((name, message)) => json!({ "error": [name, message] }),
    };
    let Some(text) = v8::String::new(scope, &reply.to_string()) else {
        return;
    };
    let receiver = v8::undefined(scope).into();
    let _ = settle.call(scope, receiver, &[text.into()]);
}

fn argument(arguments: &[Value], index: usize) -> &Value {
    arguments.get(index).unwrap_or(&Value::Null)
}

fn call(name: &str, arguments: &[Value]) -> Outcome<Value> {
    let at = |index| argument(arguments, index);
    match name {
        "digest" => digest_bytes(at(0), at(1)),
        "generateKey" => generate(at(0), boolean(at(1)), &usages(at(2))?),
        "importKey" => {
            import(text(at(0))?, at(1), at(2), boolean(at(3)), &usages(at(4))?).map(register)
        }
        "exportKey" => export(text(at(0))?, &key(at(1))?),
        "sign" => sign(at(0), &key(at(1))?, &bytes(at(2))?).map(|signature| output(&signature)),
        "verify" => verify(at(0), &key(at(1))?, &bytes(at(2))?, &bytes(at(3))?).map(Value::Bool),
        "encrypt" => crypt(at(0), &key(at(1))?, &bytes(at(2))?, "encrypt").map(|out| output(&out)),
        "decrypt" => crypt(at(0), &key(at(1))?, &bytes(at(2))?, "decrypt").map(|out| output(&out)),
        "deriveBits" => {
            derive_bits(at(0), &key(at(1))?, at(2).as_u64(), "deriveBits").map(|bits| output(&bits))
        }
        "deriveKey" => {
            derive_key(at(0), &key(at(1))?, at(2), boolean(at(3)), &usages(at(4))?).map(register)
        }
        "wrapKey" => wrap(text(at(0))?, &key(at(1))?, &key(at(2))?, at(3)).map(|out| output(&out)),
        "unwrapKey" => unwrap(
            text(at(0))?,
            &bytes(at(1))?,
            &key(at(2))?,
            at(3),
            at(4),
            boolean(at(5)),
            &usages(at(6))?,
        )
        .map(register),
        _ => fail("TypeError", "unsupported operation"),
    }
}

fn boolean(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

fn text(value: &Value) -> Outcome<&str> {
    value
        .as_str()
        .map_or_else(|| fail("TypeError", "expected a string"), Ok)
}

fn bytes(value: &Value) -> Outcome<Vec<u8>> {
    match value.get("$bytes").and_then(Value::as_str) {
        Some(text) => Ok(text
            .chars()
            .map(|character| character as u32 as u8)
            .collect()),
        None => fail(
            "TypeError",
            "expected an ArrayBuffer, TypedArray or DataView",
        ),
    }
}

fn output(bytes: &[u8]) -> Value {
    json!({ "$bytes": latin1(bytes) })
}

fn usages(value: &Value) -> Outcome<Vec<String>> {
    let Some(list) = value.as_array() else {
        return fail("TypeError", "keyUsages must be a sequence");
    };
    let mut usages = Vec::new();
    for usage in list {
        match usage.as_str() {
            Some(usage) if USAGES.contains(&usage) => {
                if !usages.iter().any(|known| known == usage) {
                    usages.push(usage.to_owned());
                }
            }
            _ => return fail("TypeError", format!("{usage} is not a valid KeyUsage")),
        }
    }
    Ok(usages)
}

fn key(value: &Value) -> Outcome<Key> {
    value
        .get("$key")
        .and_then(Value::as_u64)
        .and_then(|index| KEYS.with_borrow(|keys| keys.get(index as usize).cloned()))
        .map_or_else(|| fail("TypeError", "unknown CryptoKey"), Ok)
}

fn register(keys: Vec<Key>) -> Value {
    let mut values: Vec<Value> = KEYS.with_borrow_mut(|registry| {
        keys.into_iter()
            .map(|key| {
                let value = json!({ "$key": registry.len(), "type": key.kind, "extractable": key.extractable,
                    "algorithm": key.algorithm, "usages": key.usages });
                registry.push(key);
                value
            })
            .collect()
    });
    match values.len() {
        1 => values.remove(0),
        _ => {
            let private = values.pop().unwrap_or(Value::Null);
            let public = values.pop().unwrap_or(Value::Null);
            json!({ "publicKey": public, "privateKey": private })
        }
    }
}

fn normalize(value: &Value) -> Outcome<(&'static str, Value)> {
    let (name, dictionary) = match value {
        Value::String(name) => (name.as_str(), json!({})),
        Value::Object(object) => match object.get("name").and_then(Value::as_str) {
            Some(name) => (name, value.clone()),
            None => return fail("TypeError", "Algorithm: name is required"),
        },
        _ => return fail("TypeError", "Algorithm must be a string or an object"),
    };
    match ALGORITHMS
        .iter()
        .find(|known| known.eq_ignore_ascii_case(name))
    {
        Some(known) => Ok((known, dictionary)),
        None => fail("NotSupportedError", "Unrecognized algorithm name"),
    }
}

fn hash(dictionary: &Value) -> Outcome<&'static str> {
    match normalize(&dictionary["hash"])? {
        (name, _) if name.starts_with("SHA-") => Ok(name),
        _ => fail("NotSupportedError", "Unrecognized algorithm name"),
    }
}

fn sha(name: &str) -> &'static digest::Algorithm {
    match name {
        "SHA-1" => &digest::SHA1_FOR_LEGACY_USE_ONLY,
        "SHA-384" => &digest::SHA384,
        "SHA-512" => &digest::SHA512,
        _ => &digest::SHA256,
    }
}

fn digest_bytes(algorithm: &Value, data: &Value) -> Outcome<Value> {
    let (name, _) = normalize(algorithm)?;
    if !name.starts_with("SHA-") {
        return fail("NotSupportedError", "Unrecognized algorithm name");
    }
    Ok(output(digest::digest(sha(name), &bytes(data)?).as_ref()))
}

fn allowed(name: &str, kind: &str) -> &'static [&'static str] {
    match (name, kind) {
        ("HMAC", _) => &["sign", "verify"],
        ("AES-KW", _) => &["wrapKey", "unwrapKey"],
        ("AES-CTR" | "AES-CBC" | "AES-GCM", _) => &["encrypt", "decrypt", "wrapKey", "unwrapKey"],
        ("HKDF" | "PBKDF2", _) | ("ECDH" | "X25519", "private") => &["deriveKey", "deriveBits"],
        ("ECDH" | "X25519", _) => &[],
        ("RSA-OAEP", "public") => &["encrypt", "wrapKey"],
        ("RSA-OAEP", _) => &["decrypt", "unwrapKey"],
        (_, "public") => &["verify"],
        _ => &["sign"],
    }
}

fn checked(name: &str, kind: &'static str, usages: &[String]) -> Outcome<Vec<String>> {
    let allowed = allowed(name, kind);
    if let Some(usage) = usages
        .iter()
        .find(|usage| !allowed.contains(&usage.as_str()))
    {
        return fail(
            "SyntaxError",
            format!("Unsupported key usage for a {name} key: {usage}"),
        );
    }
    Ok(usages.to_vec())
}

fn nonempty(key: Key) -> Outcome<Key> {
    if key.kind != "public" && key.usages.is_empty() {
        return fail("SyntaxError", "Usages cannot be empty when creating a key.");
    }
    Ok(key)
}

fn usable(key: &Key, name: &str, usage: &str) -> Outcome<()> {
    if key.algorithm["name"] != name || !key.usages.iter().any(|known| known == usage) {
        return fail(
            "InvalidAccessError",
            "The requested operation is not valid for the provided key",
        );
    }
    Ok(())
}

fn secret(key: &Key) -> Outcome<&[u8]> {
    match &key.material {
        Material::Secret(bytes) => Ok(bytes),
        _ => fail(
            "InvalidAccessError",
            "The requested operation is not valid for the provided key",
        ),
    }
}

fn block_bits(hash: &str) -> usize {
    if matches!(hash, "SHA-384" | "SHA-512") {
        1024
    } else {
        512
    }
}

fn curve(dictionary: &Value) -> Outcome<Curve> {
    match dictionary["namedCurve"].as_str() {
        Some("P-256") => Ok(Curve::P256),
        Some("P-384") => Ok(Curve::P384),
        Some("P-521") => Ok(Curve::P521),
        _ => fail("NotSupportedError", "Unsupported namedCurve"),
    }
}

impl Curve {
    fn name(self) -> &'static str {
        match self {
            Curve::P256 => "P-256",
            Curve::P384 => "P-384",
            Curve::P521 => "P-521",
        }
    }

    fn oid(self) -> &'static [u8] {
        match self {
            Curve::P256 => &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
            Curve::P384 => &[0x2b, 0x81, 0x04, 0x00, 0x22],
            Curve::P521 => &[0x2b, 0x81, 0x04, 0x00, 0x23],
        }
    }

    fn scalar(self) -> usize {
        match self {
            Curve::P256 => 32,
            Curve::P384 => 48,
            Curve::P521 => 66,
        }
    }

    fn signing(self, hash: &str) -> Option<&'static signature::EcdsaSigningAlgorithm> {
        Some(match (self, hash) {
            (Curve::P256, "SHA-256") => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            (Curve::P384, "SHA-384") => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
            (Curve::P521, "SHA-256") => &signature::ECDSA_P521_SHA256_FIXED_SIGNING,
            (Curve::P521, "SHA-384") => &signature::ECDSA_P521_SHA384_FIXED_SIGNING,
            (Curve::P521, "SHA-512") => &signature::ECDSA_P521_SHA512_FIXED_SIGNING,
            _ => return None,
        })
    }

    fn verifying(self, hash: &str) -> Option<&'static signature::EcdsaVerificationAlgorithm> {
        Some(match (self, hash) {
            (Curve::P256, "SHA-256") => &signature::ECDSA_P256_SHA256_FIXED,
            (Curve::P384, "SHA-384") => &signature::ECDSA_P384_SHA384_FIXED,
            (Curve::P521, "SHA-256") => &signature::ECDSA_P521_SHA256_FIXED,
            (Curve::P521, "SHA-384") => &signature::ECDSA_P521_SHA384_FIXED,
            (Curve::P521, "SHA-512") => &signature::ECDSA_P521_SHA512_FIXED,
            _ => return None,
        })
    }

    fn parsing(self) -> &'static signature::EcdsaSigningAlgorithm {
        match self {
            Curve::P256 => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            Curve::P384 => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
            Curve::P521 => &signature::ECDSA_P521_SHA512_FIXED_SIGNING,
        }
    }

    fn agreement(self) -> &'static agreement::Algorithm {
        match self {
            Curve::P256 => &agreement::ECDH_P256,
            Curve::P384 => &agreement::ECDH_P384,
            Curve::P521 => &agreement::ECDH_P521,
        }
    }
}

fn aes_algorithm(name: &str, length: usize) -> Value {
    json!({ "name": name, "length": length })
}

fn hmac_algorithm(hash: &str, length: usize) -> Value {
    json!({ "name": "HMAC", "hash": { "name": hash }, "length": length })
}

fn rsa_algorithm(name: &str, n: &[u8], e: &[u8], hash: &str) -> Value {
    let bits = n.len() * 8 - n.first().map_or(0, |byte| byte.leading_zeros() as usize);
    json!({ "name": name, "modulusLength": bits, "publicExponent": { "$bytes": latin1(e), "view": true },
        "hash": { "name": hash } })
}

fn secret_key(algorithm: Value, extractable: bool, usages: Vec<String>, bytes: Vec<u8>) -> Key {
    Key {
        kind: "secret",
        algorithm,
        extractable,
        usages,
        material: Material::Secret(bytes),
    }
}

fn pair(public: Key, private: Key) -> Vec<Key> {
    vec![public, private]
}

fn split(name: &str, extractable: bool, usages: &[String]) -> Outcome<(Vec<String>, Vec<String>)> {
    let public: Vec<String> = usages
        .iter()
        .filter(|usage| allowed(name, "public").contains(&usage.as_str()))
        .cloned()
        .collect();
    let private: Vec<String> = usages
        .iter()
        .filter(|usage| allowed(name, "private").contains(&usage.as_str()))
        .cloned()
        .collect();
    if usages
        .iter()
        .any(|usage| !public.contains(usage) && !private.contains(usage))
    {
        return fail(
            "SyntaxError",
            format!("Unsupported key usage for a {name} key"),
        );
    }
    let _ = extractable;
    if private.is_empty() {
        return fail("SyntaxError", "Usages cannot be empty when creating a key.");
    }
    Ok((public, private))
}

fn generate(algorithm: &Value, extractable: bool, usages: &[String]) -> Outcome<Value> {
    let (name, dictionary) = normalize(algorithm)?;
    let keys = match name {
        "HMAC" => {
            let hash = hash(&dictionary)?;
            let length = dictionary["length"]
                .as_u64()
                .map_or(block_bits(hash) as u64, |bits| bits);
            if length == 0 || length % 8 != 0 || length > MAX_KEY_BITS {
                return fail(
                    "OperationError",
                    "HMAC key length must be a positive multiple of 8 up to 8388608",
                );
            }
            let length = length as usize;
            let mut bytes = vec![0; length / 8];
            operation(getrandom::fill(&mut bytes))?;
            vec![nonempty(secret_key(
                hmac_algorithm(hash, length),
                extractable,
                checked(name, "secret", usages)?,
                bytes,
            ))?]
        }
        "AES-CTR" | "AES-CBC" | "AES-GCM" | "AES-KW" => {
            let length = dictionary["length"].as_u64().unwrap_or(0) as usize;
            if ![128, 192, 256].contains(&length) {
                return fail(
                    "OperationError",
                    "AES key length must be 128, 192 or 256 bits",
                );
            }
            let mut bytes = vec![0; length / 8];
            operation(getrandom::fill(&mut bytes))?;
            vec![nonempty(secret_key(
                aes_algorithm(name, length),
                extractable,
                checked(name, "secret", usages)?,
                bytes,
            ))?]
        }
        "ECDSA" | "ECDH" => {
            let curve = curve(&dictionary)?;
            let (public_usages, private_usages) = split(name, extractable, usages)?;
            let generated = operation(signature::EcdsaKeyPair::generate(curve.parsing()))?;
            let pkcs8 = operation(generated.to_pkcs8v1())?.as_ref().to_vec();
            let public = generated.public_key().as_ref().to_vec();
            let algorithm = json!({ "name": name, "namedCurve": curve.name() });
            pair(
                Key {
                    kind: "public",
                    algorithm: algorithm.clone(),
                    extractable: true,
                    usages: public_usages,
                    material: Material::Ec {
                        curve,
                        private: None,
                        public: public.clone(),
                    },
                },
                Key {
                    kind: "private",
                    algorithm,
                    extractable,
                    usages: private_usages,
                    material: Material::Ec {
                        curve,
                        private: Some(pkcs8),
                        public,
                    },
                },
            )
        }
        "Ed25519" => {
            let (public_usages, private_usages) = split(name, extractable, usages)?;
            let generated = operation(signature::Ed25519KeyPair::generate())?;
            let pkcs8 = operation(generated.to_pkcs8v1())?.as_ref().to_vec();
            let public = generated.public_key().as_ref().to_vec();
            okp_pair(
                Okp::Ed25519,
                public,
                pkcs8,
                extractable,
                public_usages,
                private_usages,
            )
        }
        "X25519" => {
            let (public_usages, private_usages) = split(name, extractable, usages)?;
            let generated = operation(agreement::PrivateKey::generate(&agreement::X25519))?;
            let public = operation(generated.compute_public_key())?.as_ref().to_vec();
            let seed: Curve25519SeedBin = operation(generated.as_be_bytes())?;
            okp_pair(
                Okp::X25519,
                public,
                seed.as_ref().to_vec(),
                extractable,
                public_usages,
                private_usages,
            )
        }
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "RSA-OAEP" => {
            let hash = hash(&dictionary)?;
            let size = match dictionary["modulusLength"].as_u64() {
                Some(2048) => rsa::KeySize::Rsa2048,
                Some(3072) => rsa::KeySize::Rsa3072,
                Some(4096) => rsa::KeySize::Rsa4096,
                Some(8192) => rsa::KeySize::Rsa8192,
                _ => {
                    return fail(
                        "NotSupportedError",
                        "RSA modulusLength must be 2048, 3072, 4096 or 8192",
                    );
                }
            };
            if bytes(&dictionary["publicExponent"])?
                .iter()
                .skip_while(|byte| **byte == 0)
                .copied()
                .collect::<Vec<_>>()
                != [1, 0, 1]
            {
                return fail("NotSupportedError", "RSA publicExponent must be 65537");
            }
            let (public_usages, private_usages) = split(name, extractable, usages)?;
            let generated = operation(rsa::KeyPair::generate(size))?;
            let pkcs8: Pkcs8V1Der = operation(generated.as_der())?;
            let n = generated
                .public_key()
                .modulus()
                .big_endian_without_leading_zero()
                .to_vec();
            let e = generated
                .public_key()
                .exponent()
                .big_endian_without_leading_zero()
                .to_vec();
            let algorithm = rsa_algorithm(name, &n, &e, hash);
            pair(
                Key {
                    kind: "public",
                    algorithm: algorithm.clone(),
                    extractable: true,
                    usages: public_usages,
                    material: Material::Rsa {
                        private: None,
                        n: n.clone(),
                        e: e.clone(),
                    },
                },
                Key {
                    kind: "private",
                    algorithm,
                    extractable,
                    usages: private_usages,
                    material: Material::Rsa {
                        private: Some(pkcs8.as_ref().to_vec()),
                        n,
                        e,
                    },
                },
            )
        }
        _ => return fail("NotSupportedError", "Unrecognized algorithm name"),
    };
    Ok(register(keys))
}

fn okp_pair(
    curve: Okp,
    public: Vec<u8>,
    private: Vec<u8>,
    extractable: bool,
    public_usages: Vec<String>,
    private_usages: Vec<String>,
) -> Vec<Key> {
    let algorithm = json!({ "name": curve.name() });
    pair(
        Key {
            kind: "public",
            algorithm: algorithm.clone(),
            extractable: true,
            usages: public_usages,
            material: Material::Okp {
                curve,
                private: None,
                public: public.clone(),
            },
        },
        Key {
            kind: "private",
            algorithm,
            extractable,
            usages: private_usages,
            material: Material::Okp {
                curve,
                private: Some(private),
                public,
            },
        },
    )
}

impl Okp {
    fn name(self) -> &'static str {
        match self {
            Okp::Ed25519 => "Ed25519",
            Okp::X25519 => "X25519",
        }
    }

    fn oid(self) -> &'static [u8] {
        match self {
            Okp::Ed25519 => ED25519_OID,
            Okp::X25519 => X25519_OID,
        }
    }
}

fn der(tag: u8, contents: &[u8]) -> Vec<u8> {
    let mut encoded = vec![tag];
    let length = contents.len();
    if length < 0x80 {
        encoded.push(length as u8);
    } else {
        let digits: Vec<u8> = length
            .to_be_bytes()
            .into_iter()
            .skip_while(|byte| *byte == 0)
            .collect();
        encoded.push(0x80 | digits.len() as u8);
        encoded.extend(digits);
    }
    encoded.extend_from_slice(contents);
    encoded
}

fn integer(value: &[u8]) -> Vec<u8> {
    let trimmed: Vec<u8> = value
        .iter()
        .copied()
        .skip_while(|byte| *byte == 0)
        .collect();
    let mut contents = if trimmed.first().is_some_and(|byte| byte & 0x80 != 0) {
        vec![0]
    } else {
        Vec::new()
    };
    contents.extend(if trimmed.is_empty() { vec![0] } else { trimmed });
    der(0x02, &contents)
}

/// Reads one DER element: its tag, its contents and the bytes after it.
fn element(input: &[u8]) -> Outcome<(u8, &[u8], &[u8])> {
    let (&tag, rest) = data(input.split_first().ok_or(()))?;
    let (&first, rest) = data(rest.split_first().ok_or(()))?;
    let (length, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return fail("DataError", "Invalid keyData");
        }
        (
            rest[..count]
                .iter()
                .fold(0usize, |total, byte| (total << 8) | *byte as usize),
            &rest[count..],
        )
    };
    if rest.len() < length {
        return fail("DataError", "Invalid keyData");
    }
    Ok((tag, &rest[..length], &rest[length..]))
}

fn spki(algorithm: &[u8], key: &[u8]) -> Vec<u8> {
    let mut bits = vec![0];
    bits.extend_from_slice(key);
    der(0x30, &[der(0x30, algorithm), der(0x03, &bits)].concat())
}

/// The algorithm identifier contents and key bits of a SubjectPublicKeyInfo.
fn parse_spki(input: &[u8]) -> Outcome<(Vec<u8>, Vec<u8>)> {
    let (0x30, body, _) = element(input)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x30, algorithm, rest) = element(body)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x03, bits, _) = element(rest)? else {
        return fail("DataError", "Invalid keyData");
    };
    match bits.split_first() {
        Some((0, key)) => Ok((algorithm.to_vec(), key.to_vec())),
        _ => fail("DataError", "Invalid keyData"),
    }
}

fn oid(value: &[u8]) -> Vec<u8> {
    der(0x06, value)
}

/// The 32-byte private key inside an X25519 PKCS #8 document.
fn x25519_private(pkcs8: &[u8]) -> Outcome<Vec<u8>> {
    let (0x30, body, _) = element(pkcs8)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x02, _, rest) = element(body)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x30, algorithm, rest) = element(rest)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x04, wrapped, _) = element(rest)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x04, private, _) = element(wrapped)? else {
        return fail("DataError", "Invalid keyData");
    };
    if algorithm != oid(X25519_OID) || private.len() != 32 {
        return fail("DataError", "Invalid keyData");
    }
    Ok(private.to_vec())
}

/// The integers of the RSAPrivateKey inside an RSA PKCS #8 document: version, n, e, d, p, q, dp, dq, qi.
fn rsa_private_parts(pkcs8: &[u8]) -> Outcome<Vec<Vec<u8>>> {
    let (0x30, body, _) = element(pkcs8)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (_, _, rest) = element(body)?;
    let (_, _, rest) = element(rest)?;
    let (0x04, private, _) = element(rest)? else {
        return fail("DataError", "Invalid keyData");
    };
    let (0x30, mut fields, _) = element(private)? else {
        return fail("DataError", "Invalid keyData");
    };
    let mut parts = Vec::new();
    while !fields.is_empty() {
        let (0x02, value, rest) = element(fields)? else {
            return fail("DataError", "Invalid keyData");
        };
        parts.push(
            value
                .iter()
                .copied()
                .skip_while(|byte| *byte == 0)
                .collect(),
        );
        fields = rest;
    }
    if parts.len() < 9 {
        return fail("DataError", "Invalid keyData");
    }
    Ok(parts)
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn from_base64url(value: &Value) -> Outcome<Vec<u8>> {
    data(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value.as_str().unwrap_or_default()),
    )
}

fn padded(bytes: &[u8], length: usize) -> Vec<u8> {
    let mut out = vec![0; length.saturating_sub(bytes.len())];
    out.extend_from_slice(bytes);
    out
}

fn jwk_alg(name: &str, hash: &str, length: usize) -> String {
    let bits = &hash[4..];
    match name {
        "HMAC" => format!("HS{bits}"),
        "RSASSA-PKCS1-v1_5" => format!("RS{bits}"),
        "RSA-PSS" => format!("PS{bits}"),
        "RSA-OAEP" if hash == "SHA-1" => "RSA-OAEP".to_owned(),
        "RSA-OAEP" => format!("RSA-OAEP-{bits}"),
        _ => format!("A{length}{}", &name[4..]),
    }
}

fn import(
    format: &str,
    input: &Value,
    algorithm: &Value,
    extractable: bool,
    usages: &[String],
) -> Outcome<Vec<Key>> {
    let (name, dictionary) = normalize(algorithm)?;
    let jwk = || -> Outcome<&Value> {
        if !input.is_object() {
            return fail("DataError", "Invalid keyData");
        }
        if input["ext"] == false && extractable {
            return fail(
                "DataError",
                "JWK \"ext\" member was false and extractable is true",
            );
        }
        Ok(input)
    };
    let key = match name {
        "HMAC" => {
            let hash = hash(&dictionary)?;
            let raw = match format {
                "raw" => bytes(input)?,
                "jwk" => {
                    let jwk = jwk()?;
                    if jwk["kty"] != "oct" {
                        return fail("DataError", "Invalid JWK kty");
                    }
                    let raw = from_base64url(&jwk["k"])?;
                    if !jwk["alg"].is_null() && jwk["alg"] != jwk_alg(name, hash, 0) {
                        return fail("DataError", "JWK alg does not match the hash");
                    }
                    raw
                }
                _ => {
                    return fail(
                        "NotSupportedError",
                        format!("Unsupported key format {format} for HMAC"),
                    );
                }
            };
            let length = dictionary["length"]
                .as_u64()
                .map_or(raw.len() * 8, |bits| bits as usize);
            if raw.is_empty() || length != raw.len() * 8 {
                return fail("DataError", "Invalid key length");
            }
            secret_key(
                hmac_algorithm(hash, length),
                extractable,
                checked(name, "secret", usages)?,
                raw,
            )
        }
        "AES-CTR" | "AES-CBC" | "AES-GCM" | "AES-KW" => {
            let raw = match format {
                "raw" => bytes(input)?,
                "jwk" => {
                    let jwk = jwk()?;
                    if jwk["kty"] != "oct" {
                        return fail("DataError", "Invalid JWK kty");
                    }
                    let raw = from_base64url(&jwk["k"])?;
                    if !jwk["alg"].is_null() && jwk["alg"] != jwk_alg(name, "SHA-0", raw.len() * 8)
                    {
                        return fail("DataError", "JWK alg does not match the key length");
                    }
                    raw
                }
                _ => {
                    return fail(
                        "NotSupportedError",
                        format!("Unsupported key format {format} for {name}"),
                    );
                }
            };
            if ![16, 24, 32].contains(&raw.len()) {
                return fail("DataError", "Invalid key length");
            }
            secret_key(
                aes_algorithm(name, raw.len() * 8),
                extractable,
                checked(name, "secret", usages)?,
                raw,
            )
        }
        "HKDF" | "PBKDF2" => {
            if format != "raw" {
                return fail(
                    "NotSupportedError",
                    format!("Unsupported key format {format} for {name}"),
                );
            }
            if extractable {
                return fail("SyntaxError", format!("{name} keys are not extractable"));
            }
            secret_key(
                json!({ "name": name }),
                false,
                checked(name, "secret", usages)?,
                bytes(input)?,
            )
        }
        "ECDSA" | "ECDH" => import_ec(
            name,
            curve(&dictionary)?,
            format,
            input,
            jwk,
            extractable,
            usages,
        )?,
        "Ed25519" | "X25519" => {
            let curve = if name == "Ed25519" {
                Okp::Ed25519
            } else {
                Okp::X25519
            };
            import_okp(curve, format, input, jwk, extractable, usages)?
        }
        "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "RSA-OAEP" => import_rsa(
            name,
            hash(&dictionary)?,
            format,
            input,
            jwk,
            extractable,
            usages,
        )?,
        _ => return fail("NotSupportedError", "Unrecognized algorithm name"),
    };
    Ok(vec![nonempty(key)?])
}

fn import_ec<'a>(
    name: &'static str,
    curve: Curve,
    format: &str,
    input: &'a Value,
    jwk: impl Fn() -> Outcome<&'a Value>,
    extractable: bool,
    usages: &[String],
) -> Outcome<Key> {
    let algorithm = json!({ "name": name, "namedCurve": curve.name() });
    let point_length = 1 + 2 * curve.scalar();
    let public_key = |public: Vec<u8>| -> Outcome<Key> {
        if public.len() != point_length || public[0] != 4 {
            return fail("DataError", "Invalid keyData");
        }
        Ok(Key {
            kind: "public",
            algorithm: algorithm.clone(),
            extractable: true,
            usages: checked(name, "public", usages)?,
            material: Material::Ec {
                curve,
                private: None,
                public,
            },
        })
    };
    let private_key = |pkcs8: &[u8]| -> Outcome<Key> {
        let parsed = data(signature::EcdsaKeyPair::from_pkcs8(curve.parsing(), pkcs8))?;
        let normalized = operation(parsed.to_pkcs8v1())?.as_ref().to_vec();
        Ok(Key {
            kind: "private",
            algorithm: algorithm.clone(),
            extractable,
            usages: checked(name, "private", usages)?,
            material: Material::Ec {
                curve,
                private: Some(normalized),
                public: parsed.public_key().as_ref().to_vec(),
            },
        })
    };
    match format {
        "raw" => public_key(bytes(input)?),
        "spki" => {
            let (identifier, key) = parse_spki(&bytes(input)?)?;
            if identifier != [oid(EC_PUBLIC_KEY), oid(curve.oid())].concat() {
                return fail("DataError", "Invalid keyData");
            }
            public_key(key)
        }
        "pkcs8" => private_key(&bytes(input)?),
        "jwk" => {
            let jwk = jwk()?;
            if jwk["kty"] != "EC" || jwk["crv"] != curve.name() {
                return fail("DataError", "Invalid JWK kty or crv");
            }
            let mut public = vec![4];
            public.extend(padded(&from_base64url(&jwk["x"])?, curve.scalar()));
            public.extend(padded(&from_base64url(&jwk["y"])?, curve.scalar()));
            if jwk["d"].is_null() {
                return public_key(public);
            }
            let scalar = padded(&from_base64url(&jwk["d"])?, curve.scalar());
            let parsed = data(signature::EcdsaKeyPair::from_private_key_and_public_key(
                curve.parsing(),
                &scalar,
                &public,
            ))?;
            private_key(operation(parsed.to_pkcs8v1())?.as_ref())
        }
        _ => fail(
            "NotSupportedError",
            format!("Unsupported key format {format} for {name}"),
        ),
    }
}

fn import_okp<'a>(
    curve: Okp,
    format: &str,
    input: &'a Value,
    jwk: impl Fn() -> Outcome<&'a Value>,
    extractable: bool,
    usages: &[String],
) -> Outcome<Key> {
    let name = curve.name();
    let algorithm = json!({ "name": name });
    let public_key = |public: Vec<u8>| -> Outcome<Key> {
        if public.len() != 32 {
            return fail("DataError", "Invalid keyData");
        }
        Ok(Key {
            kind: "public",
            algorithm: algorithm.clone(),
            extractable: true,
            usages: checked(name, "public", usages)?,
            material: Material::Okp {
                curve,
                private: None,
                public,
            },
        })
    };
    let private_key = |private: Vec<u8>, public: Vec<u8>| -> Outcome<Key> {
        Ok(Key {
            kind: "private",
            algorithm: algorithm.clone(),
            extractable,
            usages: checked(name, "private", usages)?,
            material: Material::Okp {
                curve,
                private: Some(private),
                public,
            },
        })
    };
    let ed25519 = |pair: signature::Ed25519KeyPair| -> Outcome<Key> {
        let public = pair.public_key().as_ref().to_vec();
        private_key(operation(pair.to_pkcs8v1())?.as_ref().to_vec(), public)
    };
    let x25519 = |private: agreement::PrivateKey| -> Outcome<Key> {
        let public = operation(private.compute_public_key())?.as_ref().to_vec();
        let seed: Curve25519SeedBin = operation(private.as_be_bytes())?;
        private_key(seed.as_ref().to_vec(), public)
    };
    match (format, curve) {
        ("raw", _) => public_key(bytes(input)?),
        ("spki", _) => {
            let (identifier, key) = parse_spki(&bytes(input)?)?;
            if identifier != oid(curve.oid()) {
                return fail("DataError", "Invalid keyData");
            }
            public_key(key)
        }
        ("pkcs8", Okp::Ed25519) => ed25519(data(
            signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&bytes(input)?),
        )?),
        ("pkcs8", Okp::X25519) => {
            let raw = x25519_private(&bytes(input)?)?;
            x25519(data(agreement::PrivateKey::from_private_key(
                &agreement::X25519,
                &raw,
            ))?)
        }
        ("jwk", _) => {
            let jwk = jwk()?;
            if jwk["kty"] != "OKP" || jwk["crv"] != name {
                return fail("DataError", "Invalid JWK kty or crv");
            }
            let public = from_base64url(&jwk["x"])?;
            if jwk["d"].is_null() {
                return public_key(public);
            }
            let private = from_base64url(&jwk["d"])?;
            match curve {
                Okp::Ed25519 => ed25519(data(
                    signature::Ed25519KeyPair::from_seed_and_public_key(&private, &public),
                )?),
                Okp::X25519 => {
                    let key = x25519(data(agreement::PrivateKey::from_private_key(
                        &agreement::X25519,
                        &private,
                    ))?)?;
                    match &key.material {
                        Material::Okp {
                            public: derived, ..
                        } if *derived == public => Ok(key),
                        _ => fail("DataError", "JWK x does not match d"),
                    }
                }
            }
        }
        _ => fail(
            "NotSupportedError",
            format!("Unsupported key format {format} for {name}"),
        ),
    }
}

fn import_rsa<'a>(
    name: &'static str,
    hash: &'static str,
    format: &str,
    input: &'a Value,
    jwk: impl Fn() -> Outcome<&'a Value>,
    extractable: bool,
    usages: &[String],
) -> Outcome<Key> {
    let public_key = |n: Vec<u8>, e: Vec<u8>| -> Outcome<Key> {
        Ok(Key {
            kind: "public",
            algorithm: rsa_algorithm(name, &n, &e, hash),
            extractable: true,
            usages: checked(name, "public", usages)?,
            material: Material::Rsa {
                private: None,
                n,
                e,
            },
        })
    };
    let private_key = |pkcs8: &[u8]| -> Outcome<Key> {
        let parsed = data(rsa::KeyPair::from_pkcs8(pkcs8))?;
        let n = parsed
            .public_key()
            .modulus()
            .big_endian_without_leading_zero()
            .to_vec();
        let e = parsed
            .public_key()
            .exponent()
            .big_endian_without_leading_zero()
            .to_vec();
        let normalized: Pkcs8V1Der = operation(parsed.as_der())?;
        Ok(Key {
            kind: "private",
            algorithm: rsa_algorithm(name, &n, &e, hash),
            extractable,
            usages: checked(name, "private", usages)?,
            material: Material::Rsa {
                private: Some(normalized.as_ref().to_vec()),
                n,
                e,
            },
        })
    };
    match format {
        "spki" => {
            let parsed = data(rsa::PublicKey::from_der(&bytes(input)?))?;
            public_key(
                parsed.modulus().big_endian_without_leading_zero().to_vec(),
                parsed.exponent().big_endian_without_leading_zero().to_vec(),
            )
        }
        "pkcs8" => private_key(&bytes(input)?),
        "jwk" => {
            let jwk = jwk()?;
            if jwk["kty"] != "RSA" {
                return fail("DataError", "Invalid JWK kty");
            }
            if !jwk["alg"].is_null() && jwk["alg"] != jwk_alg(name, hash, 0) {
                return fail("DataError", "JWK alg does not match the algorithm");
            }
            let field = |name: &str| from_base64url(&jwk[name]);
            let (n, e) = (field("n")?, field("e")?);
            if jwk["d"].is_null() {
                return public_key(n, e);
            }
            let parts = ["d", "p", "q", "dp", "dq", "qi"].map(field);
            let [d, p, q, dp, dq, qi] = parts;
            let components = rsa::KeyPairComponents {
                public_key: rsa::PublicKeyComponents {
                    n: n.as_slice(),
                    e: e.as_slice(),
                },
                d: d?.as_slice().to_vec(),
                p: p?,
                q: q?,
                dP: dp?,
                dQ: dq?,
                qInv: qi?,
            };
            let components = rsa::KeyPairComponents {
                public_key: components.public_key,
                d: components.d.as_slice(),
                p: components.p.as_slice(),
                q: components.q.as_slice(),
                dP: components.dP.as_slice(),
                dQ: components.dQ.as_slice(),
                qInv: components.qInv.as_slice(),
            };
            let parsed = data(rsa::KeyPair::from_components(&components))?;
            let pkcs8: Pkcs8V1Der = operation(parsed.as_der())?;
            private_key(pkcs8.as_ref())
        }
        _ => fail(
            "NotSupportedError",
            format!("Unsupported key format {format} for {name}"),
        ),
    }
}

fn export(format: &str, key: &Key) -> Outcome<Value> {
    let name = key.algorithm["name"].as_str().unwrap_or_default();
    if matches!(name, "PBKDF2" | "HKDF") {
        return fail(
            "NotSupportedError",
            format!("{name} keys cannot be exported"),
        );
    }
    if !key.extractable {
        return fail("InvalidAccessError", "key is not extractable");
    }
    let jwk = |mut fields: serde_json::Map<String, Value>| {
        fields.insert("key_ops".into(), json!(key.usages));
        fields.insert("ext".into(), Value::Bool(key.extractable));
        Value::Object(fields)
    };
    let fields = |pairs: Vec<(&str, Value)>| {
        pairs
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect()
    };
    let unsupported = || {
        fail(
            "NotSupportedError",
            format!("Unsupported key format {format} for {name}"),
        )
    };
    let invalid = || {
        fail(
            "InvalidAccessError",
            "The requested operation is not valid for the provided key",
        )
    };
    match (&key.material, format) {
        (Material::Secret(raw), "raw") => Ok(output(raw)),
        (Material::Secret(raw), "jwk") => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-0");
            Ok(jwk(fields(vec![
                ("kty", json!("oct")),
                ("k", json!(base64url(raw))),
                ("alg", json!(jwk_alg(name, hash, raw.len() * 8))),
            ])))
        }
        (Material::Ec { public, .. }, "raw") if key.kind == "public" => Ok(output(public)),
        (Material::Ec { curve, public, .. }, "spki") if key.kind == "public" => Ok(output(&spki(
            &[oid(EC_PUBLIC_KEY), oid(curve.oid())].concat(),
            public,
        ))),
        (
            Material::Ec {
                private: Some(pkcs8),
                ..
            },
            "pkcs8",
        ) => Ok(output(pkcs8)),
        (
            Material::Ec {
                curve,
                private,
                public,
            },
            "jwk",
        ) => {
            let size = curve.scalar();
            let mut members = vec![
                ("kty", json!("EC")),
                ("crv", json!(curve.name())),
                ("x", json!(base64url(&public[1..1 + size]))),
                ("y", json!(base64url(&public[1 + size..]))),
            ];
            if let Some(pkcs8) = private {
                let parsed =
                    operation(signature::EcdsaKeyPair::from_pkcs8(curve.parsing(), pkcs8))?;
                let scalar: EcPrivateKeyBin = operation(parsed.private_key().as_be_bytes())?;
                members.push(("d", json!(base64url(&padded(scalar.as_ref(), size)))));
            }
            Ok(jwk(fields(members)))
        }
        (Material::Okp { public, .. }, "raw") if key.kind == "public" => Ok(output(public)),
        (Material::Okp { curve, public, .. }, "spki") if key.kind == "public" => {
            Ok(output(&spki(&oid(curve.oid()), public)))
        }
        (
            Material::Okp {
                curve: Okp::Ed25519,
                private: Some(pkcs8),
                ..
            },
            "pkcs8",
        ) => Ok(output(pkcs8)),
        (
            Material::Okp {
                curve: Okp::X25519,
                private: Some(raw),
                ..
            },
            "pkcs8",
        ) => Ok(output(&der(
            0x30,
            &[
                integer(&[0]),
                der(0x30, &oid(X25519_OID)),
                der(0x04, &der(0x04, raw)),
            ]
            .concat(),
        ))),
        (
            Material::Okp {
                curve,
                private,
                public,
            },
            "jwk",
        ) => {
            let mut members = vec![
                ("kty", json!("OKP")),
                ("crv", json!(curve.name())),
                ("x", json!(base64url(public))),
            ];
            match (curve, private) {
                (Okp::Ed25519, Some(pkcs8)) => {
                    let pair =
                        operation(signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8))?;
                    let seed: Curve25519SeedBin = operation(operation(pair.seed())?.as_be_bytes())?;
                    members.push(("d", json!(base64url(seed.as_ref()))));
                }
                (Okp::X25519, Some(raw)) => members.push(("d", json!(base64url(raw)))),
                _ => {}
            }
            Ok(jwk(fields(members)))
        }
        (Material::Rsa { n, e, .. }, "spki") if key.kind == "public" => {
            let components = rsa::PublicKeyComponents { n, e };
            let spki: PublicKeyX509Der = operation(components.as_der())?;
            Ok(output(spki.as_ref()))
        }
        (
            Material::Rsa {
                private: Some(pkcs8),
                ..
            },
            "pkcs8",
        ) => Ok(output(pkcs8)),
        (Material::Rsa { private, n, e }, "jwk") => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            let mut members = vec![
                ("kty", json!("RSA")),
                ("n", json!(base64url(n))),
                ("e", json!(base64url(e))),
                ("alg", json!(jwk_alg(name, hash, 0))),
            ];
            if let Some(pkcs8) = private {
                let parts = rsa_private_parts(pkcs8)?;
                for (member, part) in ["d", "p", "q", "dp", "dq", "qi"]
                    .into_iter()
                    .zip(&parts[3..9])
                {
                    members.push((member, json!(base64url(part))));
                }
            }
            Ok(jwk(fields(members)))
        }
        (_, "raw" | "spki" | "pkcs8")
            if matches!(name, "ECDSA" | "ECDH" | "Ed25519" | "X25519")
                || name.starts_with("RSA") =>
        {
            invalid()
        }
        _ => unsupported(),
    }
}

fn sign(algorithm: &Value, key: &Key, message: &[u8]) -> Outcome<Vec<u8>> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(key, name, "sign")?;
    match (&key.material, name) {
        (Material::Secret(raw), "HMAC") => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            Ok(hmac::sign(&hmac::Key::new(hmac_kind(hash), raw), message)
                .as_ref()
                .to_vec())
        }
        (
            Material::Ec {
                curve,
                private: Some(pkcs8),
                ..
            },
            "ECDSA",
        ) => {
            let hash = hash(&dictionary)?;
            let Some(algorithm) = curve.signing(hash) else {
                return fail(
                    "NotSupportedError",
                    format!("ECDSA {} with {hash} is not supported", curve.name()),
                );
            };
            let pair = operation(signature::EcdsaKeyPair::from_pkcs8(algorithm, pkcs8))?;
            Ok(operation(pair.sign(&rand::SystemRandom::new(), message))?
                .as_ref()
                .to_vec())
        }
        (
            Material::Okp {
                curve: Okp::Ed25519,
                private: Some(pkcs8),
                ..
            },
            "Ed25519",
        ) => {
            let pair = operation(signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8))?;
            Ok(pair.sign(message).as_ref().to_vec())
        }
        (
            Material::Rsa {
                private: Some(pkcs8),
                ..
            },
            "RSASSA-PKCS1-v1_5" | "RSA-PSS",
        ) => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            let encoding = rsa_encoding(name, hash, &dictionary)?;
            let pair = operation(rsa::KeyPair::from_pkcs8(pkcs8))?;
            let mut signature = vec![0; pair.public_modulus_len()];
            operation(pair.sign(
                encoding,
                &rand::SystemRandom::new(),
                message,
                &mut signature,
            ))?;
            Ok(signature)
        }
        _ => fail(
            "InvalidAccessError",
            "The requested operation is not valid for the provided key",
        ),
    }
}

fn hmac_kind(hash: &str) -> hmac::Algorithm {
    match hash {
        "SHA-1" => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
        "SHA-384" => hmac::HMAC_SHA384,
        "SHA-512" => hmac::HMAC_SHA512,
        _ => hmac::HMAC_SHA256,
    }
}

fn rsa_encoding(
    name: &str,
    hash: &str,
    dictionary: &Value,
) -> Outcome<&'static dyn signature::RsaEncoding> {
    if name == "RSA-PSS" && dictionary["saltLength"].as_u64() != Some(sha(hash).output_len() as u64)
    {
        return fail(
            "NotSupportedError",
            "RSA-PSS saltLength must equal the hash length",
        );
    }
    Ok(match (name, hash) {
        ("RSA-PSS", "SHA-384") => &signature::RSA_PSS_SHA384,
        ("RSA-PSS", "SHA-512") => &signature::RSA_PSS_SHA512,
        ("RSA-PSS", "SHA-256") => &signature::RSA_PSS_SHA256,
        ("RSASSA-PKCS1-v1_5", "SHA-384") => &signature::RSA_PKCS1_SHA384,
        ("RSASSA-PKCS1-v1_5", "SHA-512") => &signature::RSA_PKCS1_SHA512,
        ("RSASSA-PKCS1-v1_5", "SHA-256") => &signature::RSA_PKCS1_SHA256,
        _ => {
            return fail(
                "NotSupportedError",
                format!("{name} with {hash} is not supported"),
            );
        }
    })
}

fn rsa_parameters(name: &str, hash: &str) -> Outcome<&'static rsa::RsaParameters> {
    Ok(match (name, hash) {
        ("RSA-PSS", "SHA-384") => &signature::RSA_PSS_2048_8192_SHA384,
        ("RSA-PSS", "SHA-512") => &signature::RSA_PSS_2048_8192_SHA512,
        ("RSA-PSS", "SHA-256") => &signature::RSA_PSS_2048_8192_SHA256,
        ("RSASSA-PKCS1-v1_5", "SHA-384") => &signature::RSA_PKCS1_2048_8192_SHA384,
        ("RSASSA-PKCS1-v1_5", "SHA-512") => &signature::RSA_PKCS1_2048_8192_SHA512,
        ("RSASSA-PKCS1-v1_5", "SHA-256") => &signature::RSA_PKCS1_2048_8192_SHA256,
        ("RSASSA-PKCS1-v1_5", "SHA-1") => &signature::RSA_PKCS1_2048_8192_SHA1_FOR_LEGACY_USE_ONLY,
        _ => {
            return fail(
                "NotSupportedError",
                format!("{name} with {hash} is not supported"),
            );
        }
    })
}

fn verify(algorithm: &Value, key: &Key, signature_bytes: &[u8], message: &[u8]) -> Outcome<bool> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(key, name, "verify")?;
    Ok(match (&key.material, name) {
        (Material::Secret(raw), "HMAC") => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            hmac::verify(
                &hmac::Key::new(hmac_kind(hash), raw),
                message,
                signature_bytes,
            )
            .is_ok()
        }
        (Material::Ec { curve, public, .. }, "ECDSA") => {
            let hash = hash(&dictionary)?;
            let Some(algorithm) = curve.verifying(hash) else {
                return fail(
                    "NotSupportedError",
                    format!("ECDSA {} with {hash} is not supported", curve.name()),
                );
            };
            signature::UnparsedPublicKey::new(algorithm, public)
                .verify(message, signature_bytes)
                .is_ok()
        }
        (
            Material::Okp {
                curve: Okp::Ed25519,
                public,
                ..
            },
            "Ed25519",
        ) => signature::UnparsedPublicKey::new(&signature::ED25519, public)
            .verify(message, signature_bytes)
            .is_ok(),
        (Material::Rsa { n, e, .. }, "RSASSA-PKCS1-v1_5" | "RSA-PSS") => {
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            rsa_encoding(name, hash, &dictionary)?;
            let parameters = rsa_parameters(name, hash)?;
            rsa::PublicKeyComponents {
                n: n.as_slice(),
                e: e.as_slice(),
            }
            .verify(parameters, message, signature_bytes)
            .is_ok()
        }
        _ => {
            return fail(
                "InvalidAccessError",
                "The requested operation is not valid for the provided key",
            );
        }
    })
}

fn aead_kind(length: usize) -> &'static aead::Algorithm {
    match length {
        16 => &aead::AES_128_GCM,
        24 => &aead::AES_192_GCM,
        _ => &aead::AES_256_GCM,
    }
}

fn cipher_kind(length: usize) -> &'static cipher::Algorithm {
    match length {
        16 => &cipher::AES_128,
        24 => &cipher::AES_192,
        _ => &cipher::AES_256,
    }
}

fn block(value: &Value, label: &str) -> Outcome<[u8; 16]> {
    match <[u8; 16]>::try_from(bytes(value)?.as_slice()) {
        Ok(block) => Ok(block),
        Err(_) => fail("OperationError", format!("{label} must be 16 bytes")),
    }
}

fn crypt(algorithm: &Value, key: &Key, input: &[u8], usage: &str) -> Outcome<Vec<u8>> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(key, name, usage)?;
    apply(name, &dictionary, key, input, usage == "encrypt")
}

fn apply(
    name: &str,
    dictionary: &Value,
    key: &Key,
    input: &[u8],
    encrypting: bool,
) -> Outcome<Vec<u8>> {
    match name {
        "AES-GCM" => {
            let raw = secret(key)?;
            let iv = bytes(&dictionary["iv"])?;
            if iv.len() != 12 {
                return fail("NotSupportedError", "AES-GCM supports a 96-bit iv");
            }
            if !dictionary["tagLength"].is_null() && dictionary["tagLength"].as_u64() != Some(128) {
                return fail("NotSupportedError", "AES-GCM supports a 128-bit tagLength");
            }
            let additional = match &dictionary["additionalData"] {
                Value::Null => Vec::new(),
                value => bytes(value)?,
            };
            let sealing = operation(
                aead::UnboundKey::new(aead_kind(raw.len()), raw).map(aead::LessSafeKey::new),
            )?;
            let nonce = operation(aead::Nonce::try_assume_unique_for_key(&iv))?;
            let mut buffer = input.to_vec();
            if encrypting {
                operation(sealing.seal_in_place_append_tag(
                    nonce,
                    aead::Aad::from(additional),
                    &mut buffer,
                ))?;
                Ok(buffer)
            } else {
                let opened = operation(sealing.open_in_place(
                    nonce,
                    aead::Aad::from(additional),
                    &mut buffer,
                ))?;
                Ok(opened.to_vec())
            }
        }
        "AES-CBC" => {
            let raw = secret(key)?;
            let iv = block(&dictionary["iv"], "iv")?;
            let unbound = operation(cipher::UnboundCipherKey::new(cipher_kind(raw.len()), raw))?;
            let mut buffer = input.to_vec();
            if encrypting {
                let sealing = operation(cipher::PaddedBlockEncryptingKey::cbc_pkcs7(unbound))?;
                operation(sealing.less_safe_encrypt(
                    &mut buffer,
                    cipher::EncryptionContext::Iv128(FixedLength::from(iv)),
                ))?;
                Ok(buffer)
            } else {
                let opening = operation(cipher::PaddedBlockDecryptingKey::cbc_pkcs7(unbound))?;
                Ok(operation(opening.decrypt(
                    &mut buffer,
                    cipher::DecryptionContext::Iv128(FixedLength::from(iv)),
                ))?
                .to_vec())
            }
        }
        "AES-CTR" => {
            let raw = secret(key)?;
            let counter = u128::from_be_bytes(block(&dictionary["counter"], "counter")?);
            let Some(length @ 1..=128) = dictionary["length"].as_u64() else {
                return fail("OperationError", "AES-CTR length must be between 1 and 128");
            };
            let blocks = input.len().div_ceil(16) as u128;
            if length < 128 && blocks > 1 << length {
                return fail("OperationError", "The counter would wrap around");
            }
            let mask = u128::MAX >> (128 - length);
            let mut stream: Vec<u8> = (0..blocks)
                .flat_map(|index| {
                    ((counter & !mask) | (counter.wrapping_add(index) & mask)).to_be_bytes()
                })
                .collect();
            let unbound = operation(cipher::UnboundCipherKey::new(cipher_kind(raw.len()), raw))?;
            operation(operation(cipher::EncryptingKey::ecb(unbound))?.encrypt(&mut stream))?;
            Ok(input
                .iter()
                .zip(stream)
                .map(|(byte, key)| byte ^ key)
                .collect())
        }
        "RSA-OAEP" => {
            let Material::Rsa { private, n, e } = &key.material else {
                return fail(
                    "InvalidAccessError",
                    "The requested operation is not valid for the provided key",
                );
            };
            let hash = key.algorithm["hash"]["name"].as_str().unwrap_or("SHA-256");
            let oaep = match hash {
                "SHA-1" => &rsa::OAEP_SHA1_MGF1SHA1,
                "SHA-384" => &rsa::OAEP_SHA384_MGF1SHA384,
                "SHA-512" => &rsa::OAEP_SHA512_MGF1SHA512,
                _ => &rsa::OAEP_SHA256_MGF1SHA256,
            };
            let label = match &dictionary["label"] {
                Value::Null => None,
                value => Some(bytes(value)?),
            };
            if encrypting {
                let public = operation(rsa::PublicKeyComponents { n, e }.try_into())?;
                let sealing = operation(rsa::OaepPublicEncryptingKey::new(public))?;
                let mut out = vec![0; sealing.ciphertext_size()];
                Ok(operation(sealing.encrypt(oaep, input, &mut out, label.as_deref()))?.to_vec())
            } else {
                let Some(pkcs8) = private else {
                    return fail(
                        "InvalidAccessError",
                        "The requested operation is not valid for the provided key",
                    );
                };
                let private = operation(rsa::PrivateDecryptingKey::from_pkcs8(pkcs8))?;
                let opening = operation(rsa::OaepPrivateDecryptingKey::new(private))?;
                let mut out = vec![0; opening.min_output_size()];
                Ok(operation(opening.decrypt(oaep, input, &mut out, label.as_deref()))?.to_vec())
            }
        }
        "AES-KW" => {
            let raw = secret(key)?;
            let kind = match raw.len() {
                16 => &key_wrap::AES_128,
                32 => &key_wrap::AES_256,
                _ => return fail("NotSupportedError", "AES-KW supports 128- and 256-bit keys"),
            };
            let kek = operation(key_wrap::AesKek::new(kind, raw))?;
            if encrypting {
                let mut out = vec![0; input.len() + 8];
                Ok(operation(kek.wrap(input, &mut out))?.to_vec())
            } else {
                let mut out = vec![0; input.len()];
                Ok(operation(kek.unwrap(input, &mut out))?.to_vec())
            }
        }
        _ => fail(
            "NotSupportedError",
            format!("{name} cannot encrypt or decrypt"),
        ),
    }
}

struct Length(usize);

impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive_bits(algorithm: &Value, key: &Key, length: Option<u64>, usage: &str) -> Outcome<Vec<u8>> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(key, name, usage)?;
    let whole = |length: Option<u64>| -> Outcome<usize> {
        match length {
            Some(bits) if bits % 8 == 0 && bits <= MAX_KEY_BITS => Ok(bits as usize / 8),
            _ => fail(
                "OperationError",
                "length must be a multiple of 8 up to 8388608",
            ),
        }
    };
    let truncate = |mut bits: Vec<u8>| -> Outcome<Vec<u8>> {
        let Some(length) = length else {
            return Ok(bits);
        };
        if length as usize > bits.len() * 8 {
            return fail("OperationError", "length is too long for this key");
        }
        bits.truncate((length as usize).div_ceil(8));
        if length % 8 != 0
            && let Some(last) = bits.last_mut()
        {
            *last &= 0xffu8 << (8 - length % 8);
        }
        Ok(bits)
    };
    match name {
        "PBKDF2" => {
            let size = whole(length)?;
            let iterations = dictionary["iterations"]
                .as_u64()
                .and_then(|count| u32::try_from(count).ok());
            let iterations = match iterations.and_then(NonZeroU32::new) {
                Some(iterations) => iterations,
                None => {
                    return fail(
                        "OperationError",
                        "iterations must be between 1 and 4294967295",
                    );
                }
            };
            let kind = match hash(&dictionary)? {
                "SHA-1" => pbkdf2::PBKDF2_HMAC_SHA1,
                "SHA-384" => pbkdf2::PBKDF2_HMAC_SHA384,
                "SHA-512" => pbkdf2::PBKDF2_HMAC_SHA512,
                _ => pbkdf2::PBKDF2_HMAC_SHA256,
            };
            let mut out = vec![0; size];
            pbkdf2::derive(
                kind,
                iterations,
                &bytes(&dictionary["salt"])?,
                secret(key)?,
                &mut out,
            );
            Ok(out)
        }
        "HKDF" => {
            let size = whole(length)?;
            let kind = match hash(&dictionary)? {
                "SHA-1" => hkdf::HKDF_SHA1_FOR_LEGACY_USE_ONLY,
                "SHA-384" => hkdf::HKDF_SHA384,
                "SHA-512" => hkdf::HKDF_SHA512,
                _ => hkdf::HKDF_SHA256,
            };
            let info = bytes(&dictionary["info"])?;
            let pseudo = hkdf::Salt::new(kind, &bytes(&dictionary["salt"])?).extract(secret(key)?);
            let info = [info.as_slice()];
            let expanded = operation(pseudo.expand(&info, Length(size)))?;
            let mut out = vec![0; size];
            operation(expanded.fill(&mut out))?;
            Ok(out)
        }
        "ECDH" | "X25519" => {
            let peer = self::key(&dictionary["public"])?;
            if peer.kind != "public" || peer.algorithm["name"] != name {
                return fail(
                    "InvalidAccessError",
                    "The public key does not match the algorithm",
                );
            }
            let shared = match (&key.material, &peer.material) {
                (
                    Material::Ec {
                        curve,
                        private: Some(pkcs8),
                        ..
                    },
                    Material::Ec {
                        curve: other,
                        public,
                        ..
                    },
                ) if curve == other => {
                    let private = operation(agreement::PrivateKey::from_private_key_der(
                        curve.agreement(),
                        pkcs8,
                    ))?;
                    let peer = agreement::UnparsedPublicKey::new(curve.agreement(), public);
                    operation(agreement::agree(&private, peer, (), |secret| {
                        Ok(secret.to_vec())
                    }))?
                }
                (
                    Material::Okp {
                        curve: Okp::X25519,
                        private: Some(raw),
                        ..
                    },
                    Material::Okp { public, .. },
                ) => {
                    let private = operation(agreement::PrivateKey::from_private_key(
                        &agreement::X25519,
                        raw,
                    ))?;
                    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, public);
                    operation(agreement::agree(&private, peer, (), |secret| {
                        Ok(secret.to_vec())
                    }))?
                }
                _ => {
                    return fail(
                        "InvalidAccessError",
                        "The public key does not match the private key",
                    );
                }
            };
            truncate(shared)
        }
        _ => fail("NotSupportedError", format!("{name} cannot derive bits")),
    }
}

fn derived_length(algorithm: &Value) -> Outcome<u64> {
    let (name, dictionary) = normalize(algorithm)?;
    match name {
        "AES-CTR" | "AES-CBC" | "AES-GCM" | "AES-KW" => match dictionary["length"].as_u64() {
            Some(length @ (128 | 192 | 256)) => Ok(length),
            _ => fail(
                "OperationError",
                "AES key length must be 128, 192 or 256 bits",
            ),
        },
        "HMAC" => Ok(dictionary["length"]
            .as_u64()
            .unwrap_or(block_bits(hash(&dictionary)?) as u64)),
        _ => fail(
            "NotSupportedError",
            format!("{name} keys cannot be derived"),
        ),
    }
}

fn derive_key(
    algorithm: &Value,
    key: &Key,
    derived: &Value,
    extractable: bool,
    usages: &[String],
) -> Outcome<Vec<Key>> {
    let bits = derive_bits(algorithm, key, Some(derived_length(derived)?), "deriveKey")?;
    import("raw", &output(&bits), derived, extractable, usages)
}

fn wrap(format: &str, key: &Key, wrapping: &Key, algorithm: &Value) -> Outcome<Vec<u8>> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(wrapping, name, "wrapKey")?;
    let exported = export(format, key)?;
    let plain = match format {
        "jwk" => {
            let mut text = exported.to_string().into_bytes();
            if name == "AES-KW" {
                text.resize(text.len().div_ceil(8) * 8, b' ');
            }
            text
        }
        _ => bytes(&exported)?,
    };
    apply(name, &dictionary, wrapping, &plain, true)
}

#[allow(clippy::too_many_arguments)]
fn unwrap(
    format: &str,
    wrapped: &[u8],
    unwrapping: &Key,
    algorithm: &Value,
    unwrapped: &Value,
    extractable: bool,
    usages: &[String],
) -> Outcome<Vec<Key>> {
    let (name, dictionary) = normalize(algorithm)?;
    usable(unwrapping, name, "unwrapKey")?;
    let plain = apply(name, &dictionary, unwrapping, wrapped, false)?;
    let input = match format {
        "jwk" => data(serde_json::from_slice::<Value>(&plain))?,
        _ => output(&plain),
    };
    import(format, &input, unwrapped, extractable, usages)
}
