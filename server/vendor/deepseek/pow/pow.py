import json
import base64
import os
import numpy as np
import wasmtime

WASM_PATH = os.path.join(os.path.dirname(__file__), "wasm", "sha3_wasm_bg.7b9ca65ddd.wasm")

_hasher_instance = None


class _DeepSeekWASMHasher:
    def __init__(self):
        self.instance = None
        self.memory = None
        self.store = None

    def init(self, wasm_path: str):
        engine = wasmtime.Engine()
        with open(wasm_path, "rb") as f:
            wasm_bytes = f.read()
        module = wasmtime.Module(engine, wasm_bytes)
        self.store = wasmtime.Store(engine)
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        self.instance = linker.instantiate(self.store, module)
        self.memory = self.instance.exports(self.store)["memory"]
        return self

    def _write_to_memory(self, text: str):
        encoded = text.encode("utf-8")
        length = len(encoded)
        ptr = self.instance.exports(self.store)["__wbindgen_export_0"](self.store, length, 1)
        memory_view = self.memory.data_ptr(self.store)
        for i, byte in enumerate(encoded):
            memory_view[ptr + i] = byte
        return ptr, length

    def solve(self, challenge: str, salt: str, difficulty: int, expire_at: int) -> int:
        prefix = f"{salt}_{expire_at}_"
        retptr = self.instance.exports(self.store)["__wbindgen_add_to_stack_pointer"](self.store, -16)
        try:
            challenge_ptr, challenge_len = self._write_to_memory(challenge)
            prefix_ptr, prefix_len = self._write_to_memory(prefix)
            self.instance.exports(self.store)["wasm_solve"](
                self.store,
                retptr,
                challenge_ptr,
                challenge_len,
                prefix_ptr,
                prefix_len,
                float(difficulty),
            )
            memory_view = self.memory.data_ptr(self.store)
            status = int.from_bytes(bytes(memory_view[retptr: retptr + 4]), byteorder="little", signed=True)
            if status == 0:
                raise RuntimeError("WASM solver returned no result")
            value_bytes = bytes(memory_view[retptr + 8: retptr + 16])
            value = np.frombuffer(value_bytes, dtype=np.float64)[0]
            return int(value)
        finally:
            self.instance.exports(self.store)["__wbindgen_add_to_stack_pointer"](self.store, 16)


def _get_hasher() -> _DeepSeekWASMHasher:
    global _hasher_instance
    if _hasher_instance is None:
        _hasher_instance = _DeepSeekWASMHasher().init(WASM_PATH)
    return _hasher_instance


def solve_pow(
    challenge: str,
    salt: str,
    difficulty: int,
    signature: str,
    target_path: str,
    expire_at: int = 0,
) -> dict:
    hasher = _get_hasher()
    answer = hasher.solve(challenge, salt, difficulty, expire_at)
    payload = {
        "algorithm": "DeepSeekHashV1",
        "challenge": challenge,
        "salt": salt,
        "answer": answer,
        "signature": signature,
        "target_path": target_path,
    }
    return {
        "answer": answer,
        "pow_response": base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode(),
    }
