#!/usr/bin/env python3
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request


API = "https://api.github.com"
VERSION = "2026-03-10"
MAX_RESPONSE = 2 * 1024 * 1024
MAX_SNAPSHOT = 256 * 1024
PER_PAGE = 10
PATTERN = re.compile(r"github://([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9_.-]{1,100})/(issues|pulls|commits)/([1-9][0-9]{0,9}|[0-9a-f]{40})(?:/(comments|review-comments|files))?(?:\?page=([1-9][0-9]{0,2}))?\Z")


class Unavailable(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise Unavailable("github_resource_moved_reopen_canonical_repository")


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def parse(uri):
    match = PATTERN.fullmatch(uri) if isinstance(uri, str) else None
    if match is None:
        raise Unavailable("github_uri_invalid_use_exact_repository_and_resource")
    owner, repo, kind, number, part, page = match.groups()
    if repo in (".", "..") or repo.endswith(".git") or (kind == "commits") != bool(re.fullmatch(r"[0-9a-f]{40}", number)):
        raise Unavailable("github_commits_require_full_lowercase_40_character_sha")
    allowed = {"issues": {None, "comments"}, "pulls": {None, "comments", "review-comments", "files"}, "commits": {None, "files"}}
    if part not in allowed[kind] or page and part is None:
        raise Unavailable("github_resource_ambiguous_or_page_not_supported")
    return owner, repo, kind, number, part, int(page or 1)


class Client:
    def __init__(self):
        self.deadline = time.monotonic() + 18
        self.count = 0
        token = os.environ.get("OMD_GITHUB_TOKEN", "")
        if token and (len(token) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in token)):
            raise Unavailable("github_credential_invalid")
        self.headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": VERSION, "User-Agent": "oh-my-diff-artifact-reader/1"}
        if token:
            self.headers["Authorization"] = f"Bearer {token}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def get(self, path):
        self.count += 1
        if self.count > 3 or time.monotonic() >= self.deadline:
            raise Unavailable("github_request_budget_exhausted")
        request = urllib.request.Request(API + path, headers=self.headers, method="GET")
        try:
            with self.opener.open(request, timeout=max(0.1, self.deadline - time.monotonic())) as response:
                if response.status != 200 or response.headers.get_content_type() != "application/json":
                    raise Unavailable("github_response_invalid")
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    raise Unavailable("github_response_too_large_narrow_resource")
                value = json.loads(body)
                return value, 'rel="next"' in response.headers.get("Link", "")
        except urllib.error.HTTPError as error:
            if error.code in (403, 429):
                raise Unavailable(f"github_rate_or_permission_denied_retry_after={error.headers.get('Retry-After', 'unknown')}_reset={error.headers.get('X-RateLimit-Reset', 'unknown')}") from None
            if error.code in (401, 404, 410):
                raise Unavailable("github_inaccessible_deleted_or_not_authorized") from None
            raise Unavailable(f"github_http_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            raise Unavailable("github_network_or_response_unavailable") from None


def clean(value, limit=12288):
    if value is None:
        return None
    if not isinstance(value, str):
        raise Unavailable("github_response_field_invalid")
    text = "".join(char if char in "\n\t" or ord(char) >= 32 and ord(char) != 127 and not 0x202A <= ord(char) <= 0x202E and not 0x2066 <= ord(char) <= 0x2069 else " " for char in value)
    data = text.encode()
    return {"text": data[:limit].decode("utf-8", "ignore"), "truncated": len(data) > limit, "sha256": hashlib.sha256(value.encode()).hexdigest()}


def canonical(value, prefix):
    if not isinstance(value, str) or not value.startswith(prefix) or any(ord(char) < 32 for char in value):
        raise Unavailable("github_response_identity_changed")
    return value


def identity(value, kind, number, base):
    if not isinstance(value, dict):
        raise Unavailable("github_response_identity_invalid")
    if kind == "commits":
        if value.get("sha") != number:
            raise Unavailable("github_commit_identity_mismatch")
        url = f"{base}/commit/{number}"
    else:
        if value.get("number") != int(number) or kind == "issues" and "pull_request" in value:
            raise Unavailable("github_issue_or_pull_identity_ambiguous")
        url = f"{base}/{'pull' if kind == 'pulls' else 'issues'}/{number}"
    if value.get("html_url") != url:
        raise Unavailable("github_resource_moved_reopen_canonical_repository")
    return url


def read(request, client=None):
    if not isinstance(request, dict) or set(request) - {"uri", "cursor", "expected_revision", "max_bytes"}:
        raise Unavailable("github_request_invalid")
    owner, repo, kind, number, part, page = parse(request.get("uri"))
    maximum = request.get("max_bytes", 16384)
    if type(maximum) is not int or not 1 <= maximum <= 16384:
        raise Unavailable("github_page_bound_invalid")
    maximum = min(maximum, 8192)
    path = f"/repos/{owner}/{repo}/{kind}/{number}"
    base = f"https://github.com/{owner}/{repo}"
    uri = f"github://{owner}/{repo}/{kind}/{number}" + (f"/{part}?page={page}" if part else "")
    client = client or Client()
    parent, _ = client.get(path + ("?per_page=1&page=1" if kind == "commits" else ""))
    url = identity(parent, kind, number, base)
    head = parent.get("head", {}).get("sha") if kind == "pulls" else number if kind == "commits" else None
    records = []
    anchors = [url]
    has_next = False
    raw = parent
    if part:
        endpoint = (f"/repos/{owner}/{repo}/issues/{number}/comments" if part == "comments" else path + ("/comments" if part == "review-comments" else "/files"))
        if kind == "commits":
            endpoint = path
        raw, has_next = client.get(endpoint + f"?per_page={PER_PAGE}&page={page}")
        rows = raw.get("files") if kind == "commits" and isinstance(raw, dict) else raw
        if not isinstance(rows, list) or len(rows) > PER_PAGE:
            raise Unavailable("github_page_invalid")
        for row in rows:
            if not isinstance(row, dict):
                raise Unavailable("github_record_invalid")
            if part == "files":
                name = row.get("filename")
                if not isinstance(name, str) or len(name) > 1024:
                    raise Unavailable("github_file_identity_invalid")
                anchor = canonical(row.get("blob_url"), base + "/blob/") if row.get("blob_url") else url
                records.append({"filename": name, "previous_filename": row.get("previous_filename"), "sha": row.get("sha"), "status": row.get("status"), "additions": row.get("additions"), "deletions": row.get("deletions"), "patch": clean(row.get("patch")), "patch_missing": "patch" not in row, "url": anchor})
            else:
                comment_url = row.get("html_url")
                prefix = f"{base}/issues/{number}#" if part == "comments" and isinstance(comment_url, str) and comment_url.startswith(f"{base}/issues/{number}#") else url + "#"
                anchor = canonical(comment_url, prefix)
                records.append({"id": row.get("id"), "url": anchor, "updated_at": row.get("updated_at"), "body": clean(row.get("body")), "path": row.get("path"), "line": row.get("line"), "commit_id": row.get("commit_id"), "in_reply_to_id": row.get("in_reply_to_id")})
            anchors.append(anchor)
        current, _ = client.get(path + ("?per_page=1&page=1" if kind == "commits" else ""))
        identity(current, kind, number, base)
        if digest(current) != digest(parent):
            raise Unavailable("github_parent_changed_retry_from_first_page")
    else:
        records = [{"title": clean(parent.get("title"), 1024), "body": clean(parent.get("body")), "state": parent.get("state"), "updated_at": parent.get("updated_at"), "commit": clean(parent.get("commit", {}).get("message"))}]
    revision = digest({"uri": uri, "parent": parent, "page": raw})
    expected = request.get("expected_revision")
    cursor = request.get("cursor")
    offset = 0
    if cursor is not None:
        if not isinstance(cursor, str) or not re.fullmatch(r"[0-9a-f]{64}:[0-9]{1,6}", cursor):
            raise Unavailable("github_cursor_invalid")
        cursor_revision, position = cursor.split(":")
        if cursor_revision != revision or expected != revision:
            raise Unavailable("github_revision_changed_reopen_resource")
        offset = int(position)
    if expected is not None and expected != revision:
        raise Unavailable("github_revision_changed_reopen_resource")
    next_uri = f"github://{owner}/{repo}/{kind}/{number}/{part}?page={page + 1}" if has_next and page < 999 else None
    document = {"untrusted": True, "repository": f"{owner}/{repo}", "kind": kind, "number_or_commit": number, "head_sha": head, "url": url, "revision": revision, "api_page": page, "per_page": PER_PAGE if part else None, "next_uri": next_uri, "records": records, "limits": "Bodies and patches are clipped at 12 KiB with their original digest. Each API page is a separate revision; compare head SHA across PR file pages. Missing patches, GitHub's 3000-file PR cap, and omitted pages are not complete file contents."}
    data = encoded(document)
    if len(data) > MAX_SNAPSHOT or offset >= len(data):
        raise Unavailable("github_snapshot_or_cursor_out_of_bounds")
    end = min(len(data), offset + maximum)
    text = data[offset:end].decode("ascii")
    return {"canonical_uri": uri, "canonical_url": url, "identity": f"{owner}/{repo}/{kind}/{number}" + (f"/{part}/page/{page}" if part else ""), "revision": revision, "text": text, "anchors": sorted(set(anchors)), "cursor": f"{revision}:{end}" if end < len(data) else None, "truncated": end < len(data) or has_next or any(any(isinstance(value, dict) and value.get("truncated") for value in row.values()) or row.get("patch_missing", False) for row in records)}


def main():
    try:
        arguments = sys.argv[1:]
        if arguments[:1] == ["--omd-request-json"]:
            arguments = arguments[1:]
        if len(arguments) != 1 or len(arguments[0].encode()) > 16384:
            raise Unavailable("github_request_size_invalid")
        result = read(json.loads(arguments[0]))
    except (Unavailable, json.JSONDecodeError) as error:
        result = {"error": str(error)[:400]}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
