"""
OfficeAce 抓包 addon — 目标是 cli.js -> modelgw (华为云 ModelArts 网关)。

用法:
    mitmdump -s capture/oa_capture.py -p 8888 --set oa_out=capture/out

落盘结构 (capture/out/):
    index.ndjson          每行一条: {ts, id, method, url, status, ctype, req_bytes, res_bytes}
    req/<id>.json        请求体 (JSON 尽量美化, 非 JSON 存原文)
    res/<id>.sse         流式响应原始字节 (SSE)
    res/<id>.json        非流式响应体
    auth/<id>.json       只含认证流程的关键请求 (session/token 等)

过滤: 只留 officeace / huaweicloud / relayclaw 相关域 + 本地 3004。
"""
import json
import os
import re
import time
from pathlib import Path

from mitmproxy import ctx, http

OUT = Path(os.environ.get("OA_OUT", "capture/out"))

# 只关心这些域。改这里扩面。
KEEP_HOSTS = re.compile(
    r"(officeace|office-claw|huaweicloud|huaweicloud-agentarts|modelgw|relayclaw|jiuwen|agentarts)",
    re.I,
)
# 认证/令牌类路径，单独存一份，方便顺着链条读
AUTH_PATH = re.compile(r"(session/token|oauth|login|auth|token|credential|islogin)", re.I)
# 疑似 LLM 对话端点
CHAT_PATH = re.compile(r"(chat/completions|/v1/messages|responses|completions|v2/|invoke)", re.I)

_counter = [0]
_meta: dict[str, dict] = {}


def _next_id() -> str:
    _counter[0] += 1
    return f"{_counter[0]:04d}"


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:80]


def _dump(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _pretty(raw: bytes) -> bytes:
    """能 JSON 解析就美化，否则原样。"""
    try:
        return json.dumps(json.loads(raw.decode("utf-8", "replace")), ensure_ascii=False, indent=2).encode()
    except Exception:
        return raw


def _body(flow: http.HTTPFlow, which: str) -> bytes:
    msg = flow.request if which == "req" else flow.response
    if not msg:
        return b""
    try:
        raw = msg.get_content(strict=False)
        return raw or b""
    except Exception:
        return b""


def _headers(msg) -> dict:
    if not msg:
        return {}
    return {k: v for k, v in msg.headers.items()}


def _matches(flow: http.HTTPFlow) -> bool:
    host = flow.request.pretty_host
    if KEEP_HOSTS.search(host):
        return True
    # 本地 3004 也留（agent 编排层）
    if host in ("127.0.0.1", "localhost") and flow.request.port in (3004,):
        return True
    return False


def response(flow: http.HTTPFlow) -> None:
    if not _matches(flow):
        return

    fid = _next_id()
    req_raw = _body(flow, "req")
    res_raw = _body(flow, "res")
    url = flow.request.pretty_url
    status = flow.response.status_code if flow.response else 0
    ctype = (flow.response.headers.get("content-type", "") if flow.response else "").lower()

    is_sse = "event-stream" in ctype or res_raw.lstrip()[:5] in (b"data:", b"event")
    tag = "sse" if is_sse else ("json" if "json" in ctype else "raw")

    rec = {
        "id": fid,
        "ts": time.time(),
        "method": flow.request.method,
        "url": url,
        "status": status,
        "ctype": ctype,
        "req_bytes": len(req_raw),
        "res_bytes": len(res_raw),
        "kind": "auth" if AUTH_PATH.search(flow.request.path) else ("chat" if CHAT_PATH.search(flow.request.path) else "other"),
        "req_headers": _headers(flow.request),
        "res_headers": _headers(flow.response),
    }
    _meta[fid] = rec

    stem = f"{fid}_{_safe(flow.request.method)}_{_safe(Path(flow.request.path).name or 'root')}"

    if req_raw:
        _dump(OUT / "req" / f"{stem}.json", _pretty(req_raw))

    if res_raw:
        if is_sse:
            _dump(OUT / "res" / f"{stem}.sse", res_raw)
        elif tag == "json":
            _dump(OUT / "res" / f"{stem}.json", _pretty(res_raw))
        else:
            _dump(OUT / "res" / f"{stem}.{tag}", res_raw)

    if rec["kind"] == "auth":
        _dump(
            OUT / "auth" / f"{stem}.json",
            json.dumps({**rec, "request_body": req_raw.decode("utf-8", "replace")[:8000]},
                       ensure_ascii=False, indent=2).encode(),
        )

    # 增量写 index，进程被 kill 也不丢
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "index.ndjson").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    flag = "*" if rec["kind"] != "other" else " "
    ctx.log.info(f"{flag} [{fid}] {flow.request.method} {status} {url}  req={len(req_raw)}B res={len(res_raw)}B {tag}")


def done() -> None:
    out = OUT / "summary.json"
    out.write_text(json.dumps(list(_meta.values()), ensure_ascii=False, indent=2), encoding="utf-8")
    ctx.log.info(f"[oa_capture] 抓包结束, {len(_meta)} 条 -> {out}")
