from .client import DeepSeekClient
from .models import ChatResponse, ModelType, MODEL_ALIASES, resolve_model
from .exceptions import DeepSeekConnectionError, DeepSeekAPIError

__all__ = [
    "DeepSeekClient",
    "ChatResponse",
    "ModelType",
    "MODEL_ALIASES",
    "resolve_model",
    "DeepSeekConnectionError",
    "DeepSeekAPIError",
]
__version__ = "0.2.2"
