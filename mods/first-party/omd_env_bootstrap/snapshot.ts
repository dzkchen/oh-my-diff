export default String.raw`[ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1 && shims=1
has() { p=$(command -v "$1" 2>/dev/null) || return 1; [ -z "$shims" ] || case $p in /usr/bin/*) return 1;; esac; }
echo "os: $(uname -sm)"
echo "cwd: $(pwd)"
set -- $(ls -Ap 2>/dev/null)
echo "files ($#): $(echo "$@" | cut -c1-500)"
echo "languages: $({ has git && git ls-files 2>/dev/null || find . -maxdepth 3 -type f -not -path './.git/*' 2>/dev/null; } | head -20000 | sed -n 's/.*\.\([A-Za-z][A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -8 | awk '{printf "%s%s %s", (NR > 1 ? ", " : ""), $2, $1}')"
m=; for f in pyproject.toml setup.py setup.cfg requirements.txt Pipfile tox.ini noxfile.py pytest.ini package.json pnpm-lock.yaml yarn.lock package-lock.json bun.lockb go.mod Cargo.toml pom.xml build.gradle build.gradle.kts gradlew Gemfile Rakefile Makefile CMakeLists.txt composer.json mix.exs Dockerfile; do [ -e "$f" ] && m="$m $f"; done
echo "manifests:$m"
t=
{ [ -f pytest.ini ] || grep -qs '^\[tool.pytest' pyproject.toml || grep -qs '^\[tool:pytest' setup.cfg || [ -f conftest.py ] || [ -f tests/conftest.py ]; } && t="$t; pytest"
[ -f tox.ini ] && t="$t; tox"
[ -f noxfile.py ] && t="$t; nox"
[ -z "$t" ] && [ -d tests ] && ls tests 2>/dev/null | grep -q '^test.*\.py$' && t="$t; python -m pytest (tests/test_*.py)"
s=$(grep -o '"test"[[:space:]]*:[[:space:]]*"[^"]*"' package.json 2>/dev/null | head -1 | sed 's/^"test"[[:space:]]*:[[:space:]]*//')
if [ -n "$s" ]; then r=npm; [ -f pnpm-lock.yaml ] && r=pnpm; [ -f yarn.lock ] && r=yarn; [ -f bun.lockb ] && r=bun; t="$t; $r test = $s"; fi
[ -f Cargo.toml ] && t="$t; cargo test"
[ -f go.mod ] && t="$t; go test ./..."
[ -f pom.xml ] && t="$t; mvn test"
{ [ -f build.gradle ] || [ -f build.gradle.kts ]; } && { [ -f gradlew ] && t="$t; ./gradlew test" || t="$t; gradle test"; }
[ -f Gemfile ] && { [ -d spec ] && t="$t; bundle exec rspec" || t="$t; bundle exec rake test"; }
mk=$(grep -oE '^(test|tests|check|unittest|test-[A-Za-z0-9_-]+)[[:space:]]*:' Makefile 2>/dev/null | tr -d ' :' | head -4 | tr '\n' ' ')
[ -n "$mk" ] && t="$t; make: $mk"
echo "test:$t" | sed 's/^test:; /test: /'
if has git && b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); then echo "git: $b, $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') changed, last: $(git log -1 --format='%h %s' 2>/dev/null | cut -c1-80)"; else echo "git: none"; fi
v=; for c in python3 node go cargo rustc java ruby php dotnet gcc; do has $c || continue
  case $c in go) o=$(go version);; java) o=$(java -version 2>&1);; *) o=$($c --version 2>&1);; esac
  n=$(echo "$o" | head -1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1); [ -n "$n" ] || n='?'; v="$v; $c $n"; done
echo "toolchains:$v" | sed 's/^toolchains:; /toolchains: /'
u=; for c in pip uv poetry pnpm npm yarn bun make cmake mvn gradle bundle rg fd jq git curl docker; do has $c && u="$u $c"; done
echo "tools:$u"
`;
