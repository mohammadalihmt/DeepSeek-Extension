import re
import socket
import html as html_module
from typing import Optional

from ..exceptions import DeepSeekAPIError

BASE_HEADERS = {
    "User-Agent": "DeepSeek/2.0.2 iOS/26.4",
    "Content-Type": "application/json",
    "x-client-version": "2.0.2",
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-platform": "ios",
    "x-client-locale": "en_US",
    "x-client-timezone-offset": "19800",
    "x-rangers-id": "7917485426619761413",
    "x-hif-leim": "c++lgX4xwG2K8g/TrlUonAKq3uLkfPfHMAkvUJAp1+1+GSGSRxCL8uA=.xKqJ14kAcIXk4EXI",
    "x-hif-dliq": "1loG5Ynr3k1yyUyaJZ1+AeD9FBKF//xM9oam9Ji/caQrBmsaO8MzQtA=.Ickqf/tuOs4wvlza",
    "accept-language": "en-US,en;q=0.9",
    "priority": "u=3, i",
}

DEEPSEEK_BASE = "https://chat.deepseek.com/api/v0"

_JUNK_STRINGS = {"FINISHEDSEARCH", "FINSEARCH", "SEARCH_DONE"}

_original_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo


def get_headers(authorization: str, extra: Optional[dict] = None) -> dict:
    headers = {**BASE_HEADERS, "authorization": authorization}
    if extra:
        headers.update(extra)
    return headers


def check_api_response(data: dict) -> None:
    code = data.get("code", 0)
    if code != 0 or data.get("data") is None:
        msg = data.get("msg", "Unknown API error")
        if code == 40003 or "invalid token" in msg.lower() or "authorization" in msg.lower():
            raise DeepSeekAPIError(
                f"Token expired or invalid. Please get a fresh token from chat.deepseek.com. ({msg})"
            )
        raise DeepSeekAPIError(f"DeepSeek API error: {msg}")


def clean_response(text: str) -> str:
    text = html_module.unescape(text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[citation:\d+\]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_junk(val: str) -> bool:
    return val.strip() in _JUNK_STRINGS
