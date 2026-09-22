// M7 secret-custody spike driver. Talks to a real n8n (see docker-compose.yml)
// through its REST and public APIs only, and writes every artefact it reads to
// ./evidence so the canary scan can be repeated.
//
//   node run-spike.mjs setup     credential + workflow + activation + one delivery
//   node run-spike.mjs deliver   one more delivery (after a restart)
//   node run-spike.mjs collect   REST/API/execution artefacts into ./evidence
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.N8N_URL ?? 'http://127.0.0.1:5679';
const STATE = './evidence/state.json';
mkdirSync('./evidence', { recursive: true });

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

let cookie = '';
const rest = async (method, path, body) => {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { 'content-type': 'application/json', cookie, ...(state.apiKey && path.startsWith('/api/') ? { 'x-n8n-api-key': state.apiKey } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const setCookie = response.headers.get('set-cookie');
	if (setCookie) cookie = setCookie.split(';')[0];
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, json, text };
};

const login = async () => {
	const answer = await rest('POST', '/rest/login', { emailOrLdapLoginId: 'spike@example.test', password: 'SpikeOwner123!' });
	if (answer.status !== 200) throw new Error(`login ${answer.status}`);
};

const deliver = async () => {
	const response = await fetch(`${BASE}/webhook/${state.webhookId}/custody`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ probe: `delivery-${Date.now()}` }),
	});
	return response.status;
};

const setup = async () => {
	await login();
	const scopes = (await rest('GET', '/rest/api-keys/scopes')).json.data;
	const key = await rest('POST', '/rest/api-keys', { label: 'custody-spike', expiresAt: null, scopes });
	state.apiKey = key.json.data?.rawApiKey ?? key.json.data?.apiKey;

	state.credentialCanary = `M7CANARY-CRED-${randomBytes(12).toString('hex')}`;
	const credential = await rest('POST', '/rest/credentials', {
		name: 'custody spike credential',
		type: 'custodySpikeApi',
		data: { secret: state.credentialCanary },
	});
	state.credentialId = credential.json.data.id;

	state.webhookId = randomUUID();
	const workflow = await rest('POST', '/rest/workflows', {
		name: 'custody spike',
		active: false,
		nodes: [
			{
				id: randomUUID(),
				name: 'Custody Spike',
				type: 'CUSTOM.custodySpike',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
				webhookId: state.webhookId,
				credentials: { custodySpikeApi: { id: state.credentialId, name: 'custody spike credential' } },
			},
		],
		connections: {},
		settings: { saveDataSuccessExecution: 'all', saveManualExecutions: true },
	});
	state.workflowId = workflow.json.data.id;
	state.versionId = workflow.json.data.versionId;
	save();

	const activation = await rest('POST', `/api/v1/workflows/${state.workflowId}/activate`);
	console.log('activate', activation.status, activation.status === 200 ? '' : activation.text.slice(0, 300));
	console.log('deliver', await deliver());
	save();
};

const collect = async (label) => {
	await login();
	const out = {};
	out.restWorkflow = (await rest('GET', `/rest/workflows/${state.workflowId}`)).json;
	out.apiWorkflow = (await rest('GET', `/api/v1/workflows/${state.workflowId}`)).json;
	out.restCredential = (await rest('GET', `/rest/credentials/${state.credentialId}`)).json;
	out.restCredentialIncludeData = (await rest('GET', `/rest/credentials/${state.credentialId}?includeData=true`)).json;
	out.apiCredentials = (await rest('GET', '/api/v1/credentials')).json;
	const executions = (await rest('GET', `/api/v1/executions?workflowId=${state.workflowId}&includeData=true`)).json;
	out.apiExecutions = executions;
	const list = (await rest('GET', `/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: state.workflowId }))}`)).json;
	out.restExecutionList = list;
	const ids = (executions.data ?? []).map((execution) => execution.id);
	out.restExecutions = [];
	for (const id of ids) out.restExecutions.push((await rest('GET', `/rest/executions/${id}`)).json);
	writeFileSync(`./evidence/api-${label}.json`, JSON.stringify(out, null, 2));
	// What the node reported about the storage it could see, per execution.
	const reports = (executions.data ?? []).map((execution) => ({
		id: execution.id,
		status: execution.status,
		output: execution.data?.resultData?.runData?.['Custody Spike']?.[0]?.data?.main?.[0]?.[0]?.json,
	}));
	console.log(JSON.stringify(reports, null, 2));
};

const command = process.argv[2];
if (command === 'setup') await setup();
else if (command === 'deliver') console.log('deliver', await deliver());
else if (command === 'collect') await collect(process.argv[3] ?? 'now');
else throw new Error('usage: setup | deliver | collect <label>');
