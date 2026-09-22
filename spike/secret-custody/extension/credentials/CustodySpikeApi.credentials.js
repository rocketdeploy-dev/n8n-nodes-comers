'use strict';
// Spike only (M7 secret custody). A password credential holding a canary.
Object.defineProperty(exports, '__esModule', { value: true });
exports.CustodySpikeApi = void 0;
class CustodySpikeApi {
	constructor() {
		this.name = 'custodySpikeApi';
		this.displayName = 'Custody Spike API';
		this.properties = [
			{ displayName: 'Secret', name: 'secret', type: 'string', typeOptions: { password: true }, default: '' },
		];
	}
}
exports.CustodySpikeApi = CustodySpikeApi;
