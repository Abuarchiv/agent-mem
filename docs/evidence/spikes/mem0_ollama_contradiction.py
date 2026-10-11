from mem0 import Memory
cfg={"llm":{"provider":"ollama","config":{"model":"qwen3.6:35b-mlx","ollama_base_url":"http://localhost:11434","temperature":0}},
"embedder":{"provider":"ollama","config":{"model":"nomic-embed-text:latest","ollama_base_url":"http://localhost:11434"}},
"vector_store":{"provider":"faiss","config":{"path":"./faiss","embedding_model_dims":768}}}
m=Memory.from_config(cfg)
msgs=[[{"role":"user","content":"Wir nutzen pytest mit uv run pytest -x für das Projekt."}],
[{"role":"user","content":"Korrektur: wir sind auf nox umgestiegen, pytest wird nicht mehr direkt aufgerufen."}]]
for x in msgs:
    r=m.add(x,user_id="abu"); print("ADD->",r)
print("SEARCH->",m.search("Wie führe ich Tests aus?",filters={"user_id":"abu"}))
print("ALL->",m.get_all(filters={"user_id":"abu"}))
