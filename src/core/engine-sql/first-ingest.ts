import { sqlFragment } from './fragment.ts';
import type { SqlExecutor } from './executor.ts';
import { digest } from '../persistence/digest.ts';

export interface OriginEvidence {
  page_id: number;
  revision: string;
  incarnation: string;
  birth_request: string;
  edit_request: string;
  current_request: string;
  first_at: string;
  current_via: string;
  current_at: string;
}

/** Both preview and apply require the complete, source-bound evidence chain. */
function firstIngest(source: string, slug: string) {
  return sqlFragment`
    SELECT p.id AS page_id, p.knowledge_revision::text AS revision, s.incarnation::text AS incarnation,
           birth.id::text AS birth_request, edit.id::text AS edit_request, current_write.id::text AS current_request,
           p.frontmatter->>'ingested_at' AS first_at, p.ingested_via AS current_via, to_char(p.ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS current_at
    FROM pages p JOIN sources s ON s.id=p.source_id
    JOIN LATERAL (SELECT v.knowledge_revision,v.write_request_id FROM page_versions v
                  WHERE v.page_id=p.id ORDER BY v.id LIMIT 1) v0 ON true
    JOIN persistence_requests birth ON birth.id=v0.write_request_id
    JOIN persistence_requests current_write ON current_write.id=p.revision_write_request_id
    LEFT JOIN LATERAL (SELECT v.knowledge_revision,v.write_request_id FROM page_versions v
                       WHERE v.page_id=p.id ORDER BY v.id DESC LIMIT 1) previous ON current_write.operation='add_timeline_entry'
    JOIN persistence_requests edit ON edit.id=CASE WHEN current_write.operation='add_timeline_entry'
                             THEN previous.write_request_id ELSE current_write.id END
    WHERE p.source_id=${source} AND p.slug=${slug} AND p.deleted_at IS NULL AND NOT s.archived
      AND p.version_history_gap_at IS NULL AND p.body_storage='inline'
      AND NOT COALESCE(s.config->'mirror_read_only'='true'::jsonb,false)
      AND birth.source_id=s.id AND birth.source_incarnation=s.incarnation AND birth.slug=p.slug
      AND birth.state='committed' AND birth.operation='put_page' AND birth.page_id IS NULL
      AND birth.authority->'remote'='false'::jsonb AND birth.worktree_id IS NOT NULL
      AND birth.intent IS NOT NULL AND NOT (birth.intent ?| ARRAY['source_kind','ingested_via'])
      AND birth.outcome->>'revision'=v0.knowledge_revision::text AND birth.outcome->>'slug'=p.slug
      AND birth.outcome->>'source_id'=s.id AND birth.outcome->'noop'='false'::jsonb
      AND birth.outcome#>'{write_through,written}'='true'::jsonb
      AND p.created_at BETWEEN birth.created_at AND birth.completed_at
      AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
                      AND r.slug=p.slug AND r.state='committed' AND r.sequence<birth.sequence)
      AND p.frontmatter->>'source_kind'='put_page' AND p.frontmatter->>'ingested_via'='put_page'
      AND p.frontmatter->>'ingested_at'=to_char(birth.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id=p.id AND
          (v.is_deleted OR v.successor_pruned OR v.write_request_id IS NULL OR
           (v.frontmatter->'source_kind',v.frontmatter->'ingested_via',v.frontmatter->'ingested_at')
             IS DISTINCT FROM (p.frontmatter->'source_kind',p.frontmatter->'ingested_via',p.frontmatter->'ingested_at')))
      AND current_write.source_id=s.id AND current_write.source_incarnation=s.incarnation AND current_write.slug=p.slug
      AND current_write.state='committed' AND current_write.authority->'remote'='true'::jsonb
      AND current_write.outcome->>'revision'=p.knowledge_revision::text
      AND current_write.outcome->>'source_id'=s.id AND current_write.outcome->>'slug'=p.slug
      AND edit.source_id=s.id AND edit.source_incarnation=s.incarnation AND edit.slug=p.slug
      AND edit.state='committed' AND edit.authority->'remote'='true'::jsonb AND edit.operation IN ('edit_page','append_page')
      AND edit.outcome->>'revision'=COALESCE(previous.knowledge_revision,p.knowledge_revision)::text AND edit.outcome->>'slug'=p.slug AND edit.outcome->>'source_id'=s.id
      AND p.source_kind='mcp:'||edit.operation AND p.ingested_via=p.source_kind AND p.ingested_at>birth.created_at`;
}

/** A receipt-bound first-ingest projection. Setting expect permits only the exact correction previously read. */
export async function firstIngestProjection(exec: SqlExecutor, source: string, slug: string, expect?: string) {
  const evidence = firstIngest(source, slug);
  const { rows: [row] } = await exec.run<OriginEvidence>(evidence);
  if (!row) return null;
  const proof = { ...row, planned: digest(row) };
  if (expect === undefined) return proof;
  if (proof.planned !== expect) return null;
  const result = await exec.run(sqlFragment`WITH proven AS (${evidence})
    UPDATE pages p SET source_kind='put_page', ingested_via='put_page', ingested_at=proof.first_at::timestamptz
    FROM proven proof WHERE p.id=proof.page_id AND proof.revision=${row.revision} AND proof.birth_request=${row.birth_request}
      AND proof.edit_request=${row.edit_request} AND proof.current_request=${row.current_request} AND proof.incarnation=${row.incarnation}
      AND proof.current_at=${row.current_at} AND proof.first_at=${row.first_at} AND proof.current_via=${row.current_via} RETURNING p.id`);
  return result.rows.length === 1 ? proof : null;
}
