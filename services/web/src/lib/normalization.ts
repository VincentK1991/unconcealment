const EX_LOCAL = "http://localhost:4321/ontology/";
const EX_LEGACY = "https://kg.unconcealment.io/ontology/";
const SNAPSHOT_TTL_MS = 30_000;
const LABEL_TTL_MS = 300_000;

interface SameAsEdgeBinding {
  s: { value: string };
  o: { value: string };
  methods?: { value: string };
  conf?: { value: string };
}

interface CanonicalBinding {
  canonical: { value: string };
}

interface LabelBinding {
  entity: { value: string };
  label?: { value: string };
  slug?: { value: string };
}

export type CanonicalStatus = "graph" | "derived" | "conflict";

interface ClusterSnapshot {
  canonicalIri: string;
  canonicalStatus: CanonicalStatus;
  explicitCanonicalCount: number;
  members: string[];
  nonCanonicalIris: string[];
  edgeCount: number;
}

interface NormalizationSnapshot {
  datasetId: string;
  normGraph: string;
  totalEdges: number;
  totalEntities: number;
  totalClusters: number;
  displayedCanonicalCount: number;
  nonCanonicalCount: number;
  derivedCanonicalCount: number;
  conflictCanonicalCount: number;
  graphCanonicalCount: number;
  methodCounts: Array<{ method: string; label: string; count: number }>;
  clusters: ClusterSnapshot[];
}

export interface NormalizationPageCluster {
  canonicalIri: string;
  canonicalLabel: string;
  canonicalStatus: CanonicalStatus;
  explicitCanonicalCount: number;
  memberCount: number;
  edgeCount: number;
  nonCanonicals: Array<{ iri: string; label: string }>;
}

export interface NormalizationPageData {
  datasetId: string;
  normGraph: string;
  page: number;
  pageSize: number;
  totalPages: number;
  totalClusters: number;
  totalEntities: number;
  totalEdges: number;
  displayedCanonicalCount: number;
  nonCanonicalCount: number;
  derivedCanonicalCount: number;
  conflictCanonicalCount: number;
  graphCanonicalCount: number;
  methodCounts: Array<{ method: string; label: string; count: number }>;
  clusters: NormalizationPageCluster[];
}

type SnapshotCacheEntry = {
  expiresAt: number;
  value?: NormalizationSnapshot;
  promise?: Promise<NormalizationSnapshot>;
};

type LabelCacheEntry = {
  expiresAt: number;
  values: Map<string, { label?: string; slug?: string }>;
};

type NormalizationCacheStore = {
  snapshotCache: Map<string, SnapshotCacheEntry>;
  labelCache: Map<string, LabelCacheEntry>;
};

const normalizationCacheStore = (
  globalThis as typeof globalThis & { __unconcealmentNormalizationCache?: NormalizationCacheStore }
).__unconcealmentNormalizationCache ??= {
  snapshotCache: new Map<string, SnapshotCacheEntry>(),
  labelCache: new Map<string, LabelCacheEntry>(),
};

const snapshotCache = normalizationCacheStore.snapshotCache;
const labelCache = normalizationCacheStore.labelCache;

const iriTail = (iri: string) => iri.split(/[/#]/).pop() ?? iri;

const methodLabel = (method: string | undefined): string => {
  if (method === "exact-label") return "exact";
  if (method === "jaro-winkler") return "fuzzy";
  if (method === "llm-judge") return "llm";
  return method ?? "unknown";
};

async function sparqlJson<T>(
  backendUrl: string,
  datasetId: string,
  sparql: string
): Promise<T[]> {
  const res = await fetch(`${backendUrl}/query/raw?dataset=${encodeURIComponent(datasetId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-query" },
    body: sparql,
  });
  if (!res.ok) {
    throw new Error(`Backend query failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { results?: { bindings?: T[] } };
  return data.results?.bindings ?? [];
}

async function buildSnapshot(datasetId: string, backendUrl: string): Promise<NormalizationSnapshot> {
  const normGraph = `urn:${datasetId}:normalization`;

  const edgeSparql = `
    PREFIX owl: <http://www.w3.org/2002/07/owl#>
    SELECT ?s ?o
           (GROUP_CONCAT(DISTINCT ?methodRaw; separator="|") AS ?methods)
           (MAX(?confRaw) AS ?conf)
    WHERE {
      GRAPH <${normGraph}> {
        ?s owl:sameAs ?o .
        FILTER(?s != ?o)
        OPTIONAL {
          << ?s owl:sameAs ?o >>
            (<${EX_LOCAL}normalizationMethod>|<${EX_LEGACY}normalizationMethod>) ?methodRaw
        }
        OPTIONAL {
          << ?s owl:sameAs ?o >>
            (<${EX_LOCAL}confidence>|<${EX_LEGACY}confidence>) ?confRaw
        }
      }
    }
    GROUP BY ?s ?o
    ORDER BY ?s ?o
  `;

  const canonicalSparql = `
    SELECT ?canonical WHERE {
      GRAPH <${normGraph}> {
        ?canonical (<${EX_LOCAL}isCanonical>|<${EX_LEGACY}isCanonical>) true .
      }
    }
    ORDER BY ?canonical
  `;

  const [edges, canonicalRows] = await Promise.all([
    sparqlJson<SameAsEdgeBinding>(backendUrl, datasetId, edgeSparql),
    sparqlJson<CanonicalBinding>(backendUrl, datasetId, canonicalSparql),
  ]);

  const canonicalSet = new Set(canonicalRows.map((row) => row.canonical.value));
  const parent = new Map<string, string>();
  const inDegree = new Map<string, number>();

  const ensureNode = (iri: string) => {
    if (!parent.has(iri)) parent.set(iri, iri);
    if (!inDegree.has(iri)) inDegree.set(iri, 0);
  };

  const find = (iri: string): string => {
    ensureNode(iri);
    const current = parent.get(iri)!;
    if (current === iri) return iri;
    const root = find(current);
    parent.set(iri, root);
    return root;
  };

  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  for (const edge of edges) {
    const subject = edge.s.value;
    const object = edge.o.value;
    ensureNode(subject);
    ensureNode(object);
    union(subject, object);
    inDegree.set(object, (inDegree.get(object) ?? 0) + 1);
  }

  for (const canonical of canonicalSet) {
    ensureNode(canonical);
  }

  const rankMembers = (members: string[]) =>
    members.slice().sort((left, right) => {
      const degreeDiff = (inDegree.get(right) ?? 0) - (inDegree.get(left) ?? 0);
      return degreeDiff !== 0 ? degreeDiff : left.localeCompare(right);
    });

  const membersByRoot = new Map<string, Set<string>>();
  for (const iri of parent.keys()) {
    const root = find(iri);
    if (!membersByRoot.has(root)) membersByRoot.set(root, new Set());
    membersByRoot.get(root)!.add(iri);
  }

  const edgesByRoot = new Map<string, SameAsEdgeBinding[]>();
  for (const edge of edges) {
    const root = find(edge.s.value);
    if (!edgesByRoot.has(root)) edgesByRoot.set(root, []);
    edgesByRoot.get(root)!.push(edge);
  }

  const clusters = Array.from(membersByRoot.entries())
    .map(([root, memberSet]) => {
      const members = Array.from(memberSet);
      const rankedMembers = rankMembers(members);
      const explicitCanonicals = rankedMembers.filter((iri) => canonicalSet.has(iri));

      let canonicalStatus: CanonicalStatus = "derived";
      if (explicitCanonicals.length === 1) canonicalStatus = "graph";
      if (explicitCanonicals.length > 1) canonicalStatus = "conflict";

      const canonicalIri =
        canonicalStatus === "graph"
          ? explicitCanonicals[0]!
          : rankedMembers[0]!;

      const nonCanonicalIris = members
        .filter((iri) => iri !== canonicalIri)
        .sort((left, right) => left.localeCompare(right));

      return {
        canonicalIri,
        canonicalStatus,
        explicitCanonicalCount: explicitCanonicals.length,
        members: rankedMembers,
        nonCanonicalIris,
        edgeCount: (edgesByRoot.get(root) ?? []).length,
      };
    })
    .sort((left, right) =>
      right.members.length - left.members.length ||
      right.edgeCount - left.edgeCount ||
      left.canonicalIri.localeCompare(right.canonicalIri)
    );

  const allIris = Array.from(new Set(clusters.flatMap((cluster) => cluster.members)));
  const globalMethodCounts: Record<string, number> = {};
  for (const edge of edges) {
    const methods = edge.methods?.value
      ? edge.methods.value.split("|").map((value) => value.trim()).filter(Boolean)
      : ["unknown"];
    for (const method of methods) {
      globalMethodCounts[method] = (globalMethodCounts[method] ?? 0) + 1;
    }
  }

  return {
    datasetId,
    normGraph,
    totalEdges: edges.length,
    totalEntities: allIris.length,
    totalClusters: clusters.length,
    displayedCanonicalCount: clusters.length,
    nonCanonicalCount: Math.max(allIris.length - clusters.length, 0),
    derivedCanonicalCount: clusters.filter((cluster) => cluster.canonicalStatus === "derived").length,
    conflictCanonicalCount: clusters.filter((cluster) => cluster.canonicalStatus === "conflict").length,
    graphCanonicalCount: canonicalSet.size,
    methodCounts: Object.entries(globalMethodCounts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([method, count]) => ({ method, label: methodLabel(method), count })),
    clusters,
  };
}

async function getSnapshot(
  datasetId: string,
  backendUrl: string,
  forceRefresh = false
): Promise<NormalizationSnapshot> {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = snapshotCache.get(datasetId);
    if (cached?.value && cached.expiresAt > now) return cached.value;
    if (cached?.promise && cached.expiresAt > now) return cached.promise;
  }

  const promise = buildSnapshot(datasetId, backendUrl);
  snapshotCache.set(datasetId, { expiresAt: now + SNAPSHOT_TTL_MS, promise });

  try {
    const value = await promise;
    snapshotCache.set(datasetId, { expiresAt: Date.now() + SNAPSHOT_TTL_MS, value });
    return value;
  } catch (error) {
    snapshotCache.delete(datasetId);
    throw error;
  }
}

async function getLabelMap(
  datasetId: string,
  backendUrl: string,
  iris: string[]
): Promise<Map<string, { label?: string; slug?: string }>> {
  const now = Date.now();
  const cached = labelCache.get(datasetId);
  const activeCache =
    cached && cached.expiresAt > now
      ? cached
      : { expiresAt: now + LABEL_TTL_MS, values: new Map<string, { label?: string; slug?: string }>() };

  if (!cached || cached.expiresAt <= now) {
    labelCache.set(datasetId, activeCache);
  }

  const missing = iris.filter((iri) => !activeCache.values.has(iri));
  if (missing.length > 0) {
    const aboxAsserted = `urn:${datasetId}:abox:asserted`;
    const aboxInferred = `urn:${datasetId}:abox:inferred`;
    const values = missing.map((iri) => `<${iri}>`).join(" ");
    const labelSparql = `
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?entity
             (SAMPLE(?labelRaw) AS ?label)
             (SAMPLE(?slugRaw) AS ?slug)
      WHERE {
        GRAPH ?g {
          VALUES ?entity { ${values} }
          OPTIONAL { ?entity rdfs:label ?labelRaw }
          OPTIONAL { ?entity (<${EX_LOCAL}slug>|<${EX_LEGACY}slug>) ?slugRaw }
        }
        FILTER(?g IN (<${aboxAsserted}>, <${aboxInferred}>))
      }
      GROUP BY ?entity
    `;

    const rows = await sparqlJson<LabelBinding>(backendUrl, datasetId, labelSparql);
    for (const iri of missing) {
      activeCache.values.set(iri, {});
    }
    for (const row of rows) {
      const iri = row.entity?.value;
      if (!iri) continue;
      activeCache.values.set(iri, {
        label: row.label?.value,
        slug: row.slug?.value,
      });
    }
    activeCache.expiresAt = Date.now() + LABEL_TTL_MS;
  }

  const result = new Map<string, { label?: string; slug?: string }>();
  for (const iri of iris) {
    result.set(iri, activeCache.values.get(iri) ?? {});
  }
  return result;
}

export async function getNormalizationPageData(args: {
  datasetId: string;
  backendUrl: string;
  page: number;
  pageSize: number;
  forceRefresh?: boolean;
}): Promise<NormalizationPageData> {
  const snapshot = await getSnapshot(args.datasetId, args.backendUrl, args.forceRefresh);
  const totalPages = Math.max(1, Math.ceil(snapshot.totalClusters / args.pageSize));
  const page = Math.min(Math.max(1, args.page), totalPages);
  const offset = (page - 1) * args.pageSize;
  const pageClusters = snapshot.clusters.slice(offset, offset + args.pageSize);
  const pageIris = Array.from(new Set(pageClusters.flatMap((cluster) => cluster.members)));
  const labelMap = await getLabelMap(args.datasetId, args.backendUrl, pageIris);

  const displayName = (iri: string) => {
    const meta = labelMap.get(iri);
    return meta?.label ?? meta?.slug ?? iriTail(iri);
  };

  return {
    datasetId: snapshot.datasetId,
    normGraph: snapshot.normGraph,
    page,
    pageSize: args.pageSize,
    totalPages,
    totalClusters: snapshot.totalClusters,
    totalEntities: snapshot.totalEntities,
    totalEdges: snapshot.totalEdges,
    displayedCanonicalCount: snapshot.displayedCanonicalCount,
    nonCanonicalCount: snapshot.nonCanonicalCount,
    derivedCanonicalCount: snapshot.derivedCanonicalCount,
    conflictCanonicalCount: snapshot.conflictCanonicalCount,
    graphCanonicalCount: snapshot.graphCanonicalCount,
    methodCounts: snapshot.methodCounts,
    clusters: pageClusters.map((cluster) => ({
      canonicalIri: cluster.canonicalIri,
      canonicalLabel: displayName(cluster.canonicalIri),
      canonicalStatus: cluster.canonicalStatus,
      explicitCanonicalCount: cluster.explicitCanonicalCount,
      memberCount: cluster.members.length,
      edgeCount: cluster.edgeCount,
      nonCanonicals: cluster.nonCanonicalIris
        .map((iri) => ({ iri, label: displayName(iri) }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    })),
  };
}
