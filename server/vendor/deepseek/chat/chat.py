import json
import re
import httpx
from typing import Optional, Iterator, List

from ..common import DEEPSEEK_BASE, get_headers, clean_response
from ..common.common import is_junk
from ..exceptions import DeepSeekConnectionError, DeepSeekAPIError


def send_message_stream(
    authorization: str,
    chat_session_id: str,
    prompt: str,
    pow_response: str,
    session_cookie: str,
    model_type: str = "deepseek-v4-flash",
    thinking_enabled: bool = False,
    search_enabled: bool = False,
    parent_message_id: Optional[int] = None,
    ref_file_ids: Optional[List[str]] = None,
) -> Iterator[str]:
    url = f"{DEEPSEEK_BASE}/chat/completion"
    payload = {
        "prompt": prompt,
        "search_enabled": search_enabled,
        "chat_session_id": chat_session_id,
        "preempt": False,
        "model_type": model_type,
        "parent_message_id": parent_message_id,
        "audio_id": None,
        "ref_file_ids": ref_file_ids or [],
        "thinking_enabled": thinking_enabled,
    }
    extra_headers = {
        "x-ds-pow-response": pow_response,
        "Cookie": f"ds_session_id={session_cookie}",
    }
    try:
        with httpx.Client(timeout=120) as client:
            with client.stream(
                "POST",
                url,
                content=json.dumps(payload),
                headers=get_headers(authorization, extra=extra_headers),
            ) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    yield line
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise DeepSeekConnectionError(f"Cannot connect to DeepSeek: {e}") from e
    except httpx.HTTPStatusError as e:
        raise DeepSeekAPIError(f"DeepSeek API error: {e.response.status_code}") from e


def _append_to(current_type: str, val: str, response_text: str, thinking_text: str):
    if not val or is_junk(val):
        return response_text, thinking_text
    if current_type == "THINK":
        thinking_text += val
    elif current_type == "RESPONSE":
        response_text += val
    return response_text, thinking_text


def send_message(
    authorization: str,
    chat_session_id: str,
    prompt: str,
    pow_response: str,
    session_cookie: str,
    model_type: str = "deepseek-v4-flash",
    thinking_enabled: bool = False,
    search_enabled: bool = False,
    parent_message_id: Optional[int] = None,
    ref_file_ids: Optional[List[str]] = None,
) -> dict:
    response_text = ""
    thinking_text = ""
    message_id = None
    status = "WIP"
    current_type = "RESPONSE"

    for line in send_message_stream(
        authorization=authorization,
        chat_session_id=chat_session_id,
        prompt=prompt,
        pow_response=pow_response,
        session_cookie=session_cookie,
        model_type=model_type,
        thinking_enabled=thinking_enabled,
        search_enabled=search_enabled,
        parent_message_id=parent_message_id,
        ref_file_ids=ref_file_ids,
    ):
        if not line or line.startswith("event:"):
            continue
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw:
            continue
        try:
            chunk = json.loads(raw)
        except json.JSONDecodeError:
            continue

        path = chunk.get("p", "")
        op = chunk.get("o", "APPEND")
        val = chunk.get("v")

        if "p" not in chunk and "v" in chunk:
            if isinstance(val, str):
                response_text, thinking_text = _append_to(current_type, val, response_text, thinking_text)
            elif isinstance(val, dict) and "response" in val:
                response_obj = val["response"]
                message_id = response_obj.get("message_id")
                status = response_obj.get("status", "WIP")
                for frag in response_obj.get("fragments", []):
                    ftype = frag.get("type", "")
                    if ftype in ("THINK", "THINKING"):
                        current_type = "THINK"
                    elif ftype == "RESPONSE":
                        current_type = "RESPONSE"
                    content = frag.get("content", "")
                    response_text, thinking_text = _append_to(current_type, content, response_text, thinking_text)
            continue

        if path == "response/fragments" and op == "APPEND":
            frags = val if isinstance(val, list) else [val]
            for frag in frags:
                ftype = frag.get("type", "")
                if ftype in ("THINK", "THINKING"):
                    current_type = "THINK"
                elif ftype == "RESPONSE":
                    current_type = "RESPONSE"
                content = frag.get("content", "")
                response_text, thinking_text = _append_to(current_type, content, response_text, thinking_text)
            continue

        if re.match(r"response/fragments/\d+/type$", path) and isinstance(val, str):
            if val in ("THINK", "THINKING"):
                current_type = "THINK"
            elif val == "RESPONSE":
                current_type = "RESPONSE"
            continue

        if re.match(r"response/fragments/-?\d+/content$", path) and isinstance(val, str):
            response_text, thinking_text = _append_to(current_type, val, response_text, thinking_text)
            continue

        if path == "response/status" and isinstance(val, str):
            status = val
            continue

        if path == "response/message_id" and val is not None:
            message_id = val
            continue

    return {
        "message_id": message_id or 0,
        "response": clean_response(response_text),
        "thinking_content": clean_response(thinking_text) if thinking_text else None,
        "status": status,
    }
