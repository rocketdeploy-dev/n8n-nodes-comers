'use strict';
// Spike only (M7 secret custody). Exercises every storage place a community
// trigger node can reach from webhookMethods and webhook() through the public
// n8n-workflow contract, writing canary values and later reporting only
// whether they are present — never the values themselves.
Object.defineProperty(exports, '__esModule', { value: true });
exports.CustodySpike = void 0;
const { randomBytes } = require('crypto');

// Every callable the context offers, own and inherited, by name only.
const callables = (object) => {
	const names = new Set();
	for (let current = object; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
		for (const name of Object.getOwnPropertyNames(current)) {
			// Descriptors only: a getter is never invoked, since some throw
			// outside the context they belong to.
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (name !== 'constructor' && descriptor && typeof descriptor.value === 'function') names.add(name);
		}
	}
	return [...names].sort();
};
const surface = (context) => ({ context: callables(context), helpers: callables(context.helpers || {}) });

class CustodySpike {
	constructor() {
		this.description = {
			displayName: 'Custody Spike',
			name: 'custodySpike',
			group: ['trigger'],
			version: 1,
			description: 'M7 secret-custody spike',
			defaults: { name: 'Custody Spike' },
			inputs: [],
			outputs: ['main'],
			credentials: [{ name: 'custodySpikeApi', required: true }],
			webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'custody' }],
			properties: [],
		};
		this.webhookMethods = {
			default: {
				async checkExists() {
					const node = this.getWorkflowStaticData('node');
					return node.registered === true;
				},
				async create() {
					const node = this.getWorkflowStaticData('node');
					const flow = this.getWorkflowStaticData('global');
					// Stand-ins for the HMAC secret M6 returns once at registration.
					node.secret = `M7CANARY-NODE-${randomBytes(12).toString('hex')}`;
					flow.secret = `M7CANARY-FLOW-${randomBytes(12).toString('hex')}`;
					node.registered = true;
					// The API surface available here, by name only.
					this.logger.info(`custody-spike hook surface ${JSON.stringify(surface(this))}`);
					return true;
				},
				async delete() {
					const node = this.getWorkflowStaticData('node');
					const flow = this.getWorkflowStaticData('global');
					delete node.secret;
					delete node.registered;
					delete flow.secret;
					return true;
				},
			},
		};
	}

	async webhook() {
		const node = this.getWorkflowStaticData('node');
		const flow = this.getWorkflowStaticData('global');
		const credential = await this.getCredentials('custodySpikeApi');
		return {
			workflowData: [
				this.helpers.returnJsonArray([
					{
						nodeStaticCanaryPresent: typeof node.secret === 'string' && node.secret.startsWith('M7CANARY-NODE-'),
						flowStaticCanaryPresent: typeof flow.secret === 'string' && flow.secret.startsWith('M7CANARY-FLOW-'),
						credentialCanaryPresent: typeof credential.secret === 'string' && credential.secret.startsWith('M7CANARY-CRED-'),
						webhookSurface: surface(this),
					},
				]),
			],
		};
	}
}
exports.CustodySpike = CustodySpike;
