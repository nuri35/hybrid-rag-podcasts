import { ChromaClient } from 'chromadb';

const c = new ChromaClient({ path: 'http://localhost:8000' });

const col = await c.getCollection({
  name: 'podcasts',
  embeddingFunction: { generate: async () => [] },
});

console.log('=== Chroma Magnitude Check ===\n');
console.log(`Collection: podcasts`);
console.log(`Total vectors: ${await col.count()}\n`);

// peek yerine get + include kullan (embeddings explicit)
const result = await col.get({
  limit: 3,
  include: ['embeddings', 'documents', 'metadatas'],
});

console.log('Result keys:', Object.keys(result));
console.log('Embeddings present:', result.embeddings !== null);
console.log('Embeddings length:', result.embeddings?.length, '\n');

if (!result.embeddings || result.embeddings.length === 0) {
  console.error('❌ No embeddings returned. Check Chroma API or collection state.');
  process.exit(1);
}

let okCount = 0;
const TOLERANCE = 1e-4;

for (let i = 0; i < Math.min(3, result.embeddings.length); i++) {
  const v = result.embeddings[i];
  const id = result.ids[i];

  if (!Array.isArray(v) || v.length === 0) {
    console.log(
      `[${i}] id=${id}  ⚠️ embedding is empty or non-array (type=${typeof v}, length=${v?.length})`,
    );
    continue;
  }

  let sumSquares = 0;
  for (let j = 0; j < v.length; j++) sumSquares += v[j] * v[j];
  const mag = Math.sqrt(sumSquares);

  const preview = v
    .slice(0, 3)
    .map((n) => n.toFixed(6))
    .join(', ');
  const status = Math.abs(mag - 1) < TOLERANCE ? '✅' : '❌';
  if (status === '✅') okCount++;

  console.log(
    `[${i}] id=${id}  dims=${v.length}  magnitude=${mag.toFixed(6)}  ${status}  first3=[${preview}]`,
  );
}

console.log('');
if (okCount === Math.min(3, result.embeddings.length)) {
  console.log(`✅ All ${okCount} sampled vectors are unit-normalized (||v|| ≈ 1).`);
  console.log('   L2-distance ranking is mathematically equivalent to cosine similarity.');
  process.exit(0);
} else {
  console.error(
    `❌ Only ${okCount}/${Math.min(3, result.embeddings.length)} sampled vectors are unit-normalized.`,
  );
  console.error('   Re-run ingestion: npm run cli -- ingest --csv data/podcasts.csv --reset');
  process.exit(1);
}
