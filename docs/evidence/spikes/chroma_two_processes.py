import sys, time, chromadb
c = chromadb.PersistentClient(path="./ch_test")
col = c.get_or_create_collection("tests")
for i in range(20):
    col.add(ids=[f"{sys.argv[1]}{i}"], embeddings=[[0.1,0.2,0.3]], documents=[sys.argv[1]]); time.sleep(0.1)
print(sys.argv[1], "ok count", col.count())
