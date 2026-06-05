import json
import httpx

from ..common import DEEPSEEK_BASE, get_headers, check_api_response
from ..exceptions import DeepSeekConnectionError, DeepSeekAPIError


def create_session(authorization: str) -> dict:
    url = f"{DEEPSEEK_BASE}/chat_session/create"
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, content=json.dumps({}), headers=get_headers(authorization))
            resp.raise_for_status()
            data = resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise DeepSeekConnectionError(f"Cannot connect to DeepSeek: {e}") from e
    except httpx.HTTPStatusError as e:
        raise DeepSeekAPIError(f"DeepSeek API error: {e.response.status_code}") from e
    check_api_response(data)
    biz = data["data"]["biz_data"]
    session = biz["chat_session"]
    return {
        "session_id": session["id"],
        "ttl_seconds": biz["ttl_seconds"],
    }


def create_pow_challenge(authorization: str, target_path: str = "/api/v0/chat/completion") -> dict:
    url = f"{DEEPSEEK_BASE}/chat/create_pow_challenge"
    payload = {"target_path": target_path}
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, content=json.dumps(payload), headers=get_headers(authorization))
            resp.raise_for_status()
            session_cookie = None
            for key, value in resp.cookies.items():
                if key == "ds_session_id":
                    session_cookie = value
                    break
            if not session_cookie:
                set_cookie = resp.headers.get("set-cookie", "")
                if "ds_session_id=" in set_cookie:
                    part = set_cookie.split("ds_session_id=")[1]
                    session_cookie = part.split(";")[0]
            data = resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise DeepSeekConnectionError(f"Cannot connect to DeepSeek: {e}") from e
    except httpx.HTTPStatusError as e:
        raise DeepSeekAPIError(f"DeepSeek API error: {e.response.status_code}") from e
    check_api_response(data)
    challenge = data["data"]["biz_data"]["challenge"]
    return {
        "challenge": {
            "algorithm": challenge["algorithm"],
            "challenge": challenge["challenge"],
            "salt": challenge["salt"],
            "signature": challenge["signature"],
            "difficulty": challenge["difficulty"],
            "expire_at": challenge["expire_at"],
            "expire_after": challenge["expire_after"],
            "target_path": challenge["target_path"],
        },
        "session_cookie": session_cookie,
    }
