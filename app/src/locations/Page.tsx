import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageAppSDK } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  Heading,
  Note,
  Paragraph,
  Select,
  Spinner,
  Stack,
  Table,
  TextInput,
} from '@contentful/f36-components';
import { callAppAction } from '../lib/appActions';
import { LINKAGE_CONTENT_TYPE, parseLinkage, type Linkage } from '../../functions/lib/linkage';

type Step = { id: string; label: string; status: 'done' | 'missing' | 'created' | 'pending' | 'error'; detail?: string };
type CtField = { id: string; name: string; type: string };
type Ct = { sys: { id: string }; name: string; fields: CtField[] };

const BODY_TYPES = new Set(['RichText', 'Text', 'Symbol']);
const STEP_BADGE: Record<Step['status'], 'positive' | 'negative' | 'warning' | 'secondary' | 'primary'> = {
  done: 'positive',
  created: 'primary',
  pending: 'warning',
  missing: 'secondary',
  error: 'negative',
};

type Draft = Omit<Linkage, 'entryId' | 'status' | 'lastError' | 'lastSyncedAt'>;
const emptyDraft = (contentTypeId = ''): Draft => ({
  contentTypeId,
  isActive: true,
  syncDataCloud: true,
  syncKnowledge: true,
  titleField: 'title',
  bodyFieldIds: [],
  dataCategories: [],
});

const Page = () => {
  const sdk = useSDK<PageAppSDK>();
  const ids = useMemo(() => ({ spaceId: sdk.ids.space, environmentId: sdk.ids.environmentAlias ?? sdk.ids.environment, appDefinitionId: sdk.ids.app! }), [sdk]);
  const cma = sdk.cma;

  const [steps, setSteps] = useState<Step[] | null>(null);
  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [contentTypes, setContentTypes] = useState<Ct[]>([]);
  const [linkages, setLinkages] = useState<Linkage[]>([]);
  const [registryMissing, setRegistryMissing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ variant: 'positive' | 'negative'; text: string } | null>(null);
  const [coverage, setCoverage] = useState<Record<string, { rows: number; chunked: number; locales: string[] }>>({});
  const [query, setQuery] = useState('');
  const [queryType, setQueryType] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const loadCoverage = useCallback(async () => {
    try {
      const res = await callAppAction(cma, ids, 'searchKnowledge', { operation: 'stats' });
      const out: Record<string, { rows: number; chunked: number; locales: string[] }> = {};
      for (const r of res.rows ?? []) {
        const c = (out[r.contentType] ??= { rows: 0, chunked: 0, locales: [] });
        c.rows += Number(r.n);
        c.locales.push(r.locale);
      }
      for (const r of res.chunked ?? []) (out[r.contentType] ??= { rows: 0, chunked: 0, locales: [] }).chunked = Number(r.n);
      setCoverage(out);
    } catch {
      // coverage is informational only
    }
  }, [cma, ids]);

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await callAppAction(cma, ids, 'searchKnowledge', { query, contentTypeId: queryType || undefined, limit: '6' });
      setHits(res.hits ?? []);
    } catch (e) {
      setSearchError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  const loadLinkages = useCallback(async () => {
    try {
      const res = await cma.entry.getMany({ query: { content_type: LINKAGE_CONTENT_TYPE, limit: 200 } });
      setLinkages(res.items.map((e: any) => parseLinkage(e)));
      setRegistryMissing(false);
    } catch {
      setRegistryMissing(true);
    }
  }, [cma]);

  const runProvision = useCallback(
    async (operation: 'status' | 'provision') => {
      setProvisioning(operation);
      setProvisionError(null);
      try {
        const res = await callAppAction(cma, ids, 'provisionAgentforce', { operation });
        setSteps(res.steps);
      } catch (e) {
        setProvisionError((e as Error).message);
      } finally {
        setProvisioning(null);
      }
    },
    [cma, ids]
  );

  useEffect(() => {
    (async () => {
      const cts = await cma.contentType.getMany({ query: { limit: 1000 } });
      setContentTypes((cts.items as any[]).filter((c) => c.sys.id !== LINKAGE_CONTENT_TYPE));
      await loadLinkages();
    })();
    runProvision('status');
    loadCoverage();
  }, [cma, loadLinkages, runProvision, loadCoverage]);

  const ctById = useMemo(() => new Map(contentTypes.map((c) => [c.sys.id, c])), [contentTypes]);
  const draftCt = draft ? ctById.get(draft.contentTypeId) : undefined;

  function startNew(contentTypeId: string) {
    const ct = ctById.get(contentTypeId);
    const d = emptyDraft(contentTypeId);
    if (ct) {
      const has = (id: string) => ct.fields.some((f) => f.id === id);
      d.titleField = has('title') ? 'title' : ct.fields.find((f) => f.type === 'Symbol')?.id ?? '';
      d.summaryField = ['summary', 'description', 'excerpt'].find(has);
      d.bodyFieldIds = ct.fields.filter((f) => f.type === 'RichText').map((f) => f.id);
      d.slugField = has('slug') ? 'slug' : undefined;
      d.tagsField = has('tags') ? 'tags' : undefined;
      d.brandField = has('brand') ? 'brand' : undefined;
    }
    setEditingId(null);
    setDraft(d);
  }

  function startEdit(l: Linkage) {
    const { entryId, status, lastError, lastSyncedAt, ...rest } = l;
    setEditingId(entryId);
    setDraft(rest);
  }

  async function backfillOne(linkageEntryId: string) {
    let skip: number | null = 0;
    let synced = 0;
    let rows = 0;
    const problems: string[] = [];
    while (skip !== null) {
      const res: any = await callAppAction(cma, ids, 'backfillContentType', { linkageEntryId, skip: String(skip) });
      synced += res.synced;
      rows += res.rows;
      if (res.dataCloudError) problems.push(`Data 360: ${res.dataCloudError}`);
      for (const k of res.knowledgeErrors ?? []) problems.push(`Knowledge ${k.entryId}: ${JSON.stringify(k.error)}`);
      skip = res.nextSkip;
    }
    return { synced, rows, problems };
  }

  async function backfill(targets: Linkage[], busyKey: string) {
    setBusy(busyKey);
    setMessage(null);
    let synced = 0;
    let rows = 0;
    const problems: string[] = [];
    try {
      for (const l of targets) {
        try {
          const r = await backfillOne(l.entryId);
          synced += r.synced;
          rows += r.rows;
          problems.push(...r.problems.map((p) => `${l.contentTypeId}: ${p}`));
        } catch (e) {
          problems.push(`${l.contentTypeId}: ${(e as Error).message}`);
        }
      }
      setMessage(
        problems.length
          ? { variant: 'negative', text: `Synced ${synced} entries with problems: ${problems.join(' | ')}` }
          : {
              variant: 'positive',
              text: `Synced ${synced} entries (${rows} locale rows) across ${targets.length} content type(s). Knowledge is live now; the search index picks up new Data 360 rows on its next incremental refresh.`,
            }
      );
    } finally {
      setBusy(null);
      loadLinkages();
      loadCoverage();
    }
  }

  async function save() {
    if (!draft) return;
    setBusy('save');
    setMessage(null);
    try {
      const fields: Record<string, { 'en-US': unknown }> = {};
      for (const [k, v] of Object.entries(draft)) {
        if (v === undefined || v === '') continue;
        fields[k] = { 'en-US': v };
      }
      let entry: any;
      if (editingId) {
        const current: any = await cma.entry.get({ entryId: editingId });
        const keep = Object.fromEntries(['status', 'lastError', 'lastSyncedAt'].filter((k) => current.fields[k]).map((k) => [k, current.fields[k]]));
        entry = await cma.entry.update({ entryId: editingId }, { ...current, fields: { ...keep, ...fields } });
      } else {
        entry = await cma.entry.create({ contentTypeId: LINKAGE_CONTENT_TYPE }, { fields: { ...fields, status: { 'en-US': 'pending' } } });
      }
      await cma.entry.publish({ entryId: entry.sys.id }, entry);
      setDraft(null);
      setEditingId(null);
      await loadLinkages();
      await backfill([parseLinkage(entry)], entry.sys.id);
    } catch (e) {
      setMessage({ variant: 'negative', text: (e as Error).message });
      setBusy(null);
    }
  }

  const fieldSelect = (key: 'titleField' | 'summaryField' | 'brandField' | 'tagsField' | 'slugField', label: string, required = false) => (
    <FormControl isRequired={required} marginBottom="spacingS">
      <FormControl.Label>{label}</FormControl.Label>
      <Select value={(draft?.[key] as string) ?? ''} onChange={(e) => setDraft((d) => d && { ...d, [key]: e.target.value || undefined })}>
        {!required && <Select.Option value="">— none —</Select.Option>}
        {draftCt?.fields.map((f) => (
          <Select.Option key={f.id} value={f.id}>
            {f.name} ({f.id})
          </Select.Option>
        ))}
      </Select>
    </FormControl>
  );

  const unlinked = contentTypes.filter((c) => !linkages.some((l) => l.contentTypeId === c.sys.id));

  return (
    <Box padding="spacingXl" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <Heading>Agentforce &amp; Knowledge Sync</Heading>
      <Paragraph>
        Published content flows to Salesforce in two ways. <b>Data 360</b> rows feed a hybrid, multilingual search index, and its retriever
        grounds Agentforce. <b>Knowledge</b> creates one article per entry, with one translation per locale, for service reps and Service
        Replies. Every publish, unpublish or delete syncs automatically.
      </Paragraph>

      <Heading as="h2" marginTop="spacingL">
        Salesforce setup
      </Heading>
      {provisionError && <Note variant="negative">{provisionError}</Note>}
      {!steps && !provisionError && <Spinner />}
      {steps && (
        <Table>
          <Table.Body>
            {steps.map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell style={{ width: 110 }}>
                  <Badge variant={STEP_BADGE[s.status]}>{s.status}</Badge>
                </Table.Cell>
                <Table.Cell>{s.label}</Table.Cell>
                <Table.Cell style={{ wordBreak: 'break-word' }}>{s.detail}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      <Flex gap="spacingS" marginTop="spacingS">
        <Button onClick={() => runProvision('status')} isLoading={provisioning === 'status'} isDisabled={!!provisioning}>
          Re-check
        </Button>
        <Button variant="primary" onClick={() => runProvision('provision')} isLoading={provisioning === 'provision'} isDisabled={!!provisioning}>
          Provision missing
        </Button>
      </Flex>

      <Heading as="h2" marginTop="spacingXl">
        Synced content types
      </Heading>
      {registryMissing && (
        <Note variant="warning">
          The {LINKAGE_CONTENT_TYPE} content type doesn't exist yet. Run migrations/01-agentforce-sync-linkage.js against this environment.
        </Note>
      )}
      {message && (
        <Box marginBottom="spacingS">
          <Note variant={message.variant}>{message.text}</Note>
        </Box>
      )}
      {linkages.length > 0 && (
        <Paragraph>
          Every linked type feeds the same Data 360 object, search index and retriever, so one Agentforce action searches all of them. Each row
          records its content type, so you can still filter by type.
        </Paragraph>
      )}
      {linkages.length > 0 && (
        <Table>
          <Table.Head>
            <Table.Row>
              <Table.Cell>Content type</Table.Cell>
              <Table.Cell>Targets</Table.Cell>
              <Table.Cell>Status</Table.Cell>
              <Table.Cell>Last synced</Table.Cell>
              <Table.Cell>In Data 360 / indexed</Table.Cell>
              <Table.Cell />
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {linkages.map((l) => (
              <Table.Row key={l.entryId}>
                <Table.Cell>
                  {ctById.get(l.contentTypeId)?.name ?? l.contentTypeId}
                  {!l.isActive && (
                    <Badge variant="secondary" style={{ marginLeft: 8 }}>
                      inactive
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>{[l.syncDataCloud && 'Data 360', l.syncKnowledge && 'Knowledge'].filter(Boolean).join(' + ')}</Table.Cell>
                <Table.Cell>
                  <Badge variant={l.status === 'ready' ? 'positive' : l.status === 'error' ? 'negative' : 'warning'}>{l.status ?? 'pending'}</Badge>
                  {l.lastError && <div style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-word' }}>{l.lastError}</div>}
                </Table.Cell>
                <Table.Cell>{l.lastSyncedAt ? new Date(l.lastSyncedAt).toLocaleString() : '—'}</Table.Cell>
                <Table.Cell>
                  {coverage[l.contentTypeId] ? (
                    <>
                      {coverage[l.contentTypeId].rows} rows / {coverage[l.contentTypeId].chunked} indexed
                      <div style={{ fontSize: 12, color: '#67728a' }}>{coverage[l.contentTypeId].locales.sort().join(', ')}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Flex gap="spacingXs">
                    <Button size="small" onClick={() => startEdit(l)}>
                      Edit
                    </Button>
                    <Button size="small" variant="secondary" onClick={() => backfill([l], l.entryId)} isLoading={busy === l.entryId} isDisabled={!!busy}>
                      Backfill
                    </Button>
                  </Flex>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {linkages.length > 1 && (
        <Flex gap="spacingS" marginTop="spacingS">
          <Button
            variant="secondary"
            onClick={() => backfill(linkages.filter((l) => l.isActive), 'all')}
            isLoading={busy === 'all'}
            isDisabled={!!busy}
          >
            Backfill all active types
          </Button>
          <Button onClick={loadCoverage}>Refresh index coverage</Button>
        </Flex>
      )}

      {!draft && !registryMissing && unlinked.length > 0 && (
        <Flex gap="spacingS" alignItems="flex-end" marginTop="spacingM">
          <FormControl marginBottom="none">
            <FormControl.Label>Add a content type</FormControl.Label>
            <Select defaultValue="" onChange={(e) => e.target.value && startNew(e.target.value)}>
              <Select.Option value="" isDisabled>
                Choose…
              </Select.Option>
              {unlinked.map((c) => (
                <Select.Option key={c.sys.id} value={c.sys.id}>
                  {c.name}
                </Select.Option>
              ))}
            </Select>
          </FormControl>
        </Flex>
      )}

      {draft && (
        <Box marginTop="spacingL" padding="spacingL" style={{ border: '1px solid #cfd9e0', borderRadius: 6 }}>
          <Heading as="h3">{draftCt?.name ?? draft.contentTypeId}</Heading>
          <Stack flexDirection="row" spacing="spacingL" marginBottom="spacingM">
            <Checkbox isChecked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}>
              Active
            </Checkbox>
            <Checkbox isChecked={draft.syncDataCloud} onChange={(e) => setDraft({ ...draft, syncDataCloud: e.target.checked })}>
              Data 360 (Agentforce retriever)
            </Checkbox>
            <Checkbox isChecked={draft.syncKnowledge} onChange={(e) => setDraft({ ...draft, syncKnowledge: e.target.checked })}>
              Salesforce Knowledge
            </Checkbox>
          </Stack>
          <Flex gap="spacingL" flexWrap="wrap">
            <Box style={{ flex: '1 1 300px' }}>
              {fieldSelect('titleField', 'Title', true)}
              {fieldSelect('summaryField', 'Summary')}
              {fieldSelect('slugField', 'Slug')}
              {fieldSelect('tagsField', 'Tags')}
              {fieldSelect('brandField', 'Brand field')}
              <FormControl marginBottom="spacingS">
                <FormControl.Label>Static brand (if no brand field)</FormControl.Label>
                <TextInput value={draft.brand ?? ''} onChange={(e) => setDraft({ ...draft, brand: e.target.value || undefined })} />
              </FormControl>
            </Box>
            <Box style={{ flex: '1 1 300px' }}>
              <FormControl marginBottom="spacingS">
                <FormControl.Label>Body fields (concatenated in order)</FormControl.Label>
                <Stack flexDirection="column" alignItems="flex-start" spacing="spacing2Xs">
                  {draftCt?.fields
                    .filter((f) => BODY_TYPES.has(f.type))
                    .map((f) => (
                      <Checkbox
                        key={f.id}
                        isChecked={draft.bodyFieldIds.includes(f.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            bodyFieldIds: e.target.checked ? [...draft.bodyFieldIds, f.id] : draft.bodyFieldIds.filter((x) => x !== f.id),
                          })
                        }
                      >
                        {f.name} <span style={{ color: '#67728a' }}>({f.type})</span>
                      </Checkbox>
                    ))}
                </Stack>
              </FormControl>
              <FormControl marginBottom="spacingS">
                <FormControl.Label>Public URL template</FormControl.Label>
                <TextInput
                  value={draft.urlTemplate ?? ''}
                  placeholder="https://www.example.com/{locale}/help/{slug}"
                  onChange={(e) => setDraft({ ...draft, urlTemplate: e.target.value || undefined })}
                />
                <FormControl.HelpText>Shown to reps and cited by Agentforce. Supports {'{locale}'}, {'{slug}'}, {'{entryId}'}.</FormControl.HelpText>
              </FormControl>
              <FormControl marginBottom="spacingS">
                <FormControl.Label>Knowledge data categories</FormControl.Label>
                <TextInput
                  value={draft.dataCategories.join(', ')}
                  placeholder="Products.Coffee_Machines"
                  onChange={(e) => setDraft({ ...draft, dataCategories: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                />
                <FormControl.HelpText>Comma-separated Group.Category developer names.</FormControl.HelpText>
              </FormControl>
            </Box>
          </Flex>
          <Flex gap="spacingS" marginTop="spacingM">
            <Button variant="primary" onClick={save} isLoading={busy === 'save'} isDisabled={!!busy || !draft.titleField || draft.bodyFieldIds.length === 0}>
              Save &amp; backfill
            </Button>
            <Button
              onClick={() => {
                setDraft(null);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
          </Flex>
        </Box>
      )}

      <Heading as="h2" marginTop="spacingXl">
        Test retrieval
      </Heading>
      <Paragraph>
        Runs the same hybrid vector and keyword search the Agentforce retriever uses. Ask in any language; results can come from any linked
        content type and locale.
      </Paragraph>
      <Flex gap="spacingS" alignItems="flex-end">
        <FormControl marginBottom="none" style={{ flex: 1 }}>
          <FormControl.Label>Question</FormControl.Label>
          <TextInput
            value={query}
            placeholder="my machine's red light keeps blinking"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
        </FormControl>
        <FormControl marginBottom="none">
          <FormControl.Label>Content type</FormControl.Label>
          <Select value={queryType} onChange={(e) => setQueryType(e.target.value)}>
            <Select.Option value="">All types</Select.Option>
            {linkages.map((l) => (
              <Select.Option key={l.contentTypeId} value={l.contentTypeId}>
                {ctById.get(l.contentTypeId)?.name ?? l.contentTypeId}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <Button variant="primary" onClick={runSearch} isLoading={searching} isDisabled={searching || !query.trim()}>
          Search
        </Button>
      </Flex>
      {searchError && (
        <Box marginTop="spacingS">
          <Note variant="negative">{searchError}</Note>
        </Box>
      )}
      {hits && hits.length === 0 && (
        <Box marginTop="spacingS">
          <Note>No passages found.</Note>
        </Box>
      )}
      {hits && hits.length > 0 && (
        <Table style={{ marginTop: 12 }}>
          <Table.Head>
            <Table.Row>
              <Table.Cell style={{ width: 70 }}>Score</Table.Cell>
              <Table.Cell>Article</Table.Cell>
              <Table.Cell>Passage</Table.Cell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {hits.map((h, i) => (
              <Table.Row key={i}>
                <Table.Cell>{Number(h.score).toFixed(2)}</Table.Cell>
                <Table.Cell style={{ width: 320 }}>
                  <div>
                    <b>{h.title}</b>
                  </div>
                  <Flex gap="spacing2Xs" marginTop="spacing2Xs" flexWrap="wrap">
                    <Badge variant="primary">{ctById.get(h.contentType)?.name ?? h.contentType}</Badge>
                    <Badge variant="secondary">{h.locale}</Badge>
                    {h.brand && <Badge variant="featured">{h.brand}</Badge>}
                  </Flex>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {h.url && (
                      <a href={h.url} target="_blank" rel="noreferrer">
                        public URL
                      </a>
                    )}
                    {h.editUrl && (
                      <>
                        {' · '}
                        <a href={h.editUrl} target="_blank" rel="noreferrer">
                          edit in Contentful
                        </a>
                      </>
                    )}
                  </div>
                </Table.Cell>
                <Table.Cell style={{ fontSize: 13 }}>{String(h.chunk ?? '').slice(0, 400)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </Box>
  );
};

export default Page;
