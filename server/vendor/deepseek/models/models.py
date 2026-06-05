from dataclasses import dataclass
from typing import Optional, Literal

ModelType = Literal["deepseek-v4-flash", "deepseek-v4-pro"]

MODEL_ALIASES: dict = {
    "deepseek-v4-flash": "default",
    "deepseek-v4-pro": "expert",
}


def resolve_model(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


@dataclass
class ChatResponse:
    session_id: str
    message_id: int
    response: str
    model_type: str
    thinking_enabled: bool
    search_enabled: bool
    status: str
    thinking_content: Optional[str] = None
    answer: Optional[str] = None

    @property
    def full_response(self) -> str:
        if self.thinking_content:
            return f"{self.thinking_content}\n\n{self.answer or self.response}"
        return self.response
