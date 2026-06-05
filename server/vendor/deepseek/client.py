import json
import re
import time
from typing import Optional, Dict, List, Iterator

from .models import ChatResponse, ModelType, resolve_model
from .session import create_session, create_pow_challenge
from .chat import send_message, send_message_stream
from .common.common import is_junk
from .files import upload_file as _upload_file_http, fetch_files as _fetch_files_http
from .pow import solve_pow
from .exceptions import DeepSeekAPIError


class DeepSeekClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self._last_message_id: Dict[str, int] = {}

    def _solve_challenge(self, target_path: str):
        pow_data = create_pow_challenge(self.api_key, target_path=target_path)
        challenge = pow_data["challenge"]
        session_cookie = pow_data.get("session_cookie", "")
        solved = solve_pow(
            challenge=challenge["challenge"],
            salt=challenge["salt"],
            difficulty=challenge["difficulty"],
            signature=challenge["signature"],
            target_path=challenge["target_path"],
            expire_at=challenge["expire_at"],
        )
        return solved["pow_response"], session_cookie

    def upload_file(
        self,
        file_path: str,
        model: ModelType = "deepseek-v4-flash",
        thinking: bool = False,
        poll_interval: float = 1.0,
        timeout: float = 120.0,
    ) -> str:
        pow_response, session_cookie = self._solve_challenge("/api/v0/file/upload_file")
        result = _upload_file_http(
            authorization=self.api_key,
            file_path=file_path,
            pow_response=pow_response,
            session_cookie=session_cookie,
            model_type=resolve_model(model),
            thinking_enabled=thinking,
        )
        file_id = result["id"]
        return self._wait_for_file(file_id, poll_interval=poll_interval, timeout=timeout)

    def _wait_for_file(self, file_id: str, poll_interval: float = 1.0, timeout: float = 120.0) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            files = _fetch_files_http(self.api_key, [file_id])
            if not files:
                raise RuntimeError(f"File {file_id} not found")
            f = files[0]
            status = f.get("status")
            if status == "SUCCESS":
                return file_id
            if status == "FAILED" or f.get("error_code"):
                raise DeepSeekAPIError(
                    f"File upload failed for {f.get('file_name')}: {f.get('error_code') or 'unknown error'}"
                )
            time.sleep(poll_interval)
        raise DeepSeekAPIError(f"File parsing timed out after {timeout}s for {file_id}")

    def fetch_files(self, file_ids: List[str]) -> List[dict]:
        return _fetch_files_http(self.api_key, file_ids)

    def chat(
        self,
        prompt: str,
        model: ModelType = "deepseek-v4-flash",
        thinking: bool = False,
        search: bool = False,
        session_id: Optional[str] = None,
        parent_message_id: Optional[int] = None,
        files: Optional[List[str]] = None,
        file_ids: Optional[List[str]] = None,
    ) -> ChatResponse:
        if not session_id:
            session_data = create_session(self.api_key)
            session_id = session_data["session_id"]

        if parent_message_id is None:
            parent_message_id = self._last_message_id.get(session_id)

        all_file_ids: List[str] = list(file_ids) if file_ids else []
        if files:
            for path in files:
                uploaded_id = self.upload_file(path, model=model, thinking=thinking)
                all_file_ids.append(uploaded_id)

        pow_response, session_cookie = self._solve_challenge("/api/v0/chat/completion")

        result = send_message(
            authorization=self.api_key,
            chat_session_id=session_id,
            prompt=prompt,
            pow_response=pow_response,
            session_cookie=session_cookie,
            model_type=resolve_model(model),
            thinking_enabled=thinking,
            search_enabled=search,
            parent_message_id=parent_message_id,
            ref_file_ids=all_file_ids or None,
        )

        message_id = result["message_id"]
        if message_id:
            self._last_message_id[session_id] = message_id

        return ChatResponse(
            session_id=session_id,
            message_id=message_id,
            response=result["response"],
            model_type=model,
            thinking_enabled=thinking,
            search_enabled=search,
            status=result["status"],
            thinking_content=result.get("thinking_content"),
            answer=result["response"],
        )

    def chat_stream(
        self,
        prompt: str,
        model: ModelType = "deepseek-v4-flash",
        thinking: bool = False,
        search: bool = False,
        session_id: Optional[str] = None,
        parent_message_id: Optional[int] = None,
        file_ids: Optional[List[str]] = None,
    ) -> Iterator[str]:
        if not session_id:
            session_data = create_session(self.api_key)
            session_id = session_data["session_id"]

        if parent_message_id is None:
            parent_message_id = self._last_message_id.get(session_id)

        pow_response, session_cookie = self._solve_challenge("/api/v0/chat/completion")

        current_type = "RESPONSE"

        for line in send_message_stream(
            authorization=self.api_key,
            chat_session_id=session_id,
            prompt=prompt,
            pow_response=pow_response,
            session_cookie=session_cookie,
            model_type=resolve_model(model),
            thinking_enabled=thinking,
            search_enabled=search,
            parent_message_id=parent_message_id,
            ref_file_ids=file_ids or None,
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
            val = chunk.get("v")
            op = chunk.get("o", "APPEND")

            if re.match(r"response/fragments/\d+/type$", path) and isinstance(val, str):
                if val in ("THINK", "THINKING"):
                    current_type = "THINK"
                elif val == "RESPONSE":
                    current_type = "RESPONSE"
                continue

            if re.match(r"response/fragments/-?\d+/content$", path) and isinstance(val, str):
                if not is_junk(val) and current_type == "RESPONSE":
                    yield val
                continue

            if path == "response/fragments" and op == "APPEND" and isinstance(val, list):
                for frag in val:
                    ftype = frag.get("type", "")
                    if ftype in ("THINK", "THINKING"):
                        current_type = "THINK"
                    elif ftype == "RESPONSE":
                        current_type = "RESPONSE"
                    content = frag.get("content", "")
                    if content and not is_junk(content) and current_type == "RESPONSE":
                        yield content
                continue

            if "p" not in chunk and isinstance(val, dict) and "response" in val:
                for frag in val["response"].get("fragments", []):
                    ftype = frag.get("type", "")
                    if ftype in ("THINK", "THINKING"):
                        current_type = "THINK"
                    elif ftype == "RESPONSE":
                        current_type = "RESPONSE"
                    content = frag.get("content", "")
                    if content and not is_junk(content) and current_type == "RESPONSE":
                        yield content
