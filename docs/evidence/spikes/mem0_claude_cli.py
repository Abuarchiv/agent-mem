import subprocess, tempfile, os
from mem0 import Memory
from mem0.llms.base import LLMBase
from mem0.utils.factory import LlmFactory
from mem0.configs.llms.base import BaseLlmConfig

class ClaudeCliLLM(LLMBase):
    def generate_response(self, messages, response_format=None, tools=None, tool_choice="auto", **kw):
        text = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages)
        text += "\n\nAntworte ausschließlich mit dem geforderten JSON." if response_format else ""
        env = {**os.environ, "AGENT_MEM_INTERNAL": "1"}
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(["claude","-p","--restricted","--setting-sources","","--tools","","--strict-mcp-config","--no-session-persistence","--model","haiku"],
                input=text, capture_output=True, text=True, cwd=d, env=env, timeout=120)
        if r.returncode: raise RuntimeError(r.stderr[:300])
        return r.stdout.strip()

cfg={"llm":{"provider":"ollama","config":{"model":"qwen3.5:4b-mlx"}},
"embedder":{"provider":"ollama","config":{"model":"nomic-embed-text:latest","ollama_base_url":"http://localhost:11434"}},
"vector_store":{"provider":"faiss","config":{"path":"./faiss2","embedding_model_dims":768}}}
m=Memory.from_config(cfg)
m.llm=ClaudeCliLLM(BaseLlmConfig(model="haiku"))
for t in ["Wir nutzen pytest mit uv run pytest -x für das Projekt.","Korrektur: wir sind auf nox umgestiegen, pytest wird nicht mehr direkt aufgerufen."]:
    print("ADD->",m.add([{"role":"user","content":t}],user_id="abu"))
print("ALL->",[x["memory"] for x in m.get_all(filters={"user_id":"abu"})["results"]])
