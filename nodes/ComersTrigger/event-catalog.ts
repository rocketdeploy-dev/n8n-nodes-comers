import type { IHookFunctions, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { CATALOG_PATH, comersConnection, comersError, comersRequest } from './comers-api';

const EVENT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
type Context = IHookFunctions | ILoadOptionsFunctions;

interface CatalogEvent {
	eventKey: string;
	eventVersion: number;
	producer: string;
	subject: string;
	description: string;
	deprecatedFrom?: string;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Fail closed: options only exist when the public catalog contract is sound. */
export const catalogOptions = (value: unknown): INodePropertyOptions[] | undefined => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const events = (value as { events?: unknown }).events;
	if (!Array.isArray(events)) return undefined;
	const seen = new Set<string>();
	const options: INodePropertyOptions[] = [];
	for (const raw of events) {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
		const event = raw as Partial<CatalogEvent>;
		const version = event.eventVersion;
		if (!EVENT_KEY.test(String(event.eventKey ?? '')) || !Number.isSafeInteger(version) || version === undefined || version < 1 || !isText(event.producer) || !isText(event.subject) || !isText(event.description) || (event.deprecatedFrom !== undefined && !isText(event.deprecatedFrom))) return undefined;
		const value = `${event.eventKey}@${version}`;
		if (seen.has(value)) return undefined;
		seen.add(value);
		options.push({
			name: `${event.description.replace(/\.$/u, '')} (v${version})${event.deprecatedFrom === undefined ? '' : ' — deprecated'} · ${event.eventKey}`,
			value,
			description: `${event.producer} · ${event.subject}${event.deprecatedFrom === undefined ? '' : ` · deprecated from ${event.deprecatedFrom}`}`,
		});
	}
	return options.sort((left, right) => String(left.name).localeCompare(String(right.name)));
};

export async function getEventOptions(this: Context): Promise<INodePropertyOptions[]> {
	const connection = await comersConnection.call(this);
	const response = await comersRequest.call(this, connection, 'GET', CATALOG_PATH);
	const options = response.statusCode === 200 ? catalogOptions(response.body) : undefined;
	if (options === undefined) throw comersError(this, response.statusCode === 503 || response.statusCode === 502 ? 'The Comers event catalog is temporarily unavailable. Try again.' : 'Comers returned an invalid event catalog.');
	return options;
}
