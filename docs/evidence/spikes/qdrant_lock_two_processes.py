import sys, time
from filelock import FileLock
from qdrant_client import QdrantClient, models
who=sys.argv[1]; t0=time.time(); opens=[]
for i in range(15):
    with FileLock("./qd2.lock", timeout=30):
        s=time.time()
        c=QdrantClient(path="./qd2")
        if not c.collection_exists("tests"):
            c.create_collection("tests", vectors_config=models.VectorParams(size=3, distance=models.Distance.COSINE))
        c.upsert("tests", points=[models.PointStruct(id=abs(hash(who+str(i)))%10**9, vector=[.1,.2,.3], payload={"w":who})])
        c.close(); opens.append(time.time()-s)
print(who, "ok, open+write median ms", round(sorted(opens)[len(opens)//2]*1000))
