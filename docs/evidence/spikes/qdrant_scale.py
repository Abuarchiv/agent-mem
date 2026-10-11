import time, uuid, shutil, numpy as np, sys
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
D=384
for N in (1000, 5000, 20000):
    p=f"qscale_{N}"; shutil.rmtree(p, ignore_errors=True)
    c=QdrantClient(path=p); c.create_collection("m", vectors_config=VectorParams(size=D, distance=Distance.COSINE))
    rng=np.random.default_rng(0)
    for i in range(0,N,1000):
        pts=[PointStruct(id=str(uuid.uuid4()), vector=rng.random(D).tolist(), payload={"data":f"fact {j}","user_id":"u"}) for j in range(i,min(i+1000,N))]
        c.upsert("m", pts)
    c.close()
    ts=[]
    for _ in range(5):
        t=time.perf_counter(); c=QdrantClient(path=p); c.query_points("m", query=rng.random(D).tolist(), limit=5); c.close(); ts.append(time.perf_counter()-t)
    import os
    size=sum(os.path.getsize(os.path.join(r,f)) for r,_,fs in os.walk(p) for f in fs)/1e6
    print(f"N={N:6d} open+search+close median={sorted(ts)[2]*1000:.0f} ms  disk={size:.0f} MB")
    shutil.rmtree(p, ignore_errors=True)
