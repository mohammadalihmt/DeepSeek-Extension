import os
import mimetypes
import httpx
from typing import List

from ..common import DEEPSEEK_BASE, get_headers, check_api_response
from ..exceptions import DeepSeekConnectionError, DeepSeekAPIError


def upload_file(
    authorization: str,
    file_path: str,
    pow_response: str,
    session_cookie: str,
    model_type: str = "default",
    thinking_enabled: bool = False,
) -> dict:
    file_size = os.path.getsize(file_path)
    file_name = os.path.basename(file_path)
    mime_type, _ = mimetypes.guess_type(file_name)
    if not mime_type:
        mime_type = "application/octet-stream"

    url = f"{DEEPSEEK_BASE}/file/upload_file"
    extra_headers = {
        "x-file-size": str(file_size),
        "upload-draft-interop-version": "6",
        "upload-complete": "?1",
        "x-thinking-enabled": "1" if thinking_enabled else "0",
        "x-model-type": model_type,
        "x-ds-pow-response": pow_response,
        "Cookie": f"ds_session_id={session_cookie}",
    }
    headers = get_headers(authorization, extra=extra_headers)
    headers.pop("Content-Type", None)

    try:
        with open(file_path, "rb") as f:
            files = {"file": (file_name, f, mime_type)}
            with httpx.Client(timeout=300) as client:
                resp = client.post(url, files=files, headers=headers)
                resp.raise_for_status()
                data = resp.json()
    except FileNotFoundError as e:
        raise DeepSeekAPIError(f"File not found: {file_path}") from e
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise DeepSeekConnectionError(f"Cannot connect to DeepSeek: {e}") from e
    except httpx.HTTPStatusError as e:
        raise DeepSeekAPIError(f"DeepSeek API error: {e.response.status_code}") from e
    check_api_response(data)
    return data["data"]["biz_data"]


def fetch_files(authorization: str, file_ids: List[str]) -> List[dict]:
    if not file_ids:
        return []
    ids = ",".join(file_ids)
    url = f"{DEEPSEEK_BASE}/file/fetch_files?file_ids={ids}"
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(url, headers=get_headers(authorization))
            resp.raise_for_status()
            data = resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise DeepSeekConnectionError(f"Cannot connect to DeepSeek: {e}") from e
    except httpx.HTTPStatusError as e:
        raise DeepSeekAPIError(f"DeepSeek API error: {e.response.status_code}") from e
    check_api_response(data)
    return data["data"]["biz_data"]["files"]
