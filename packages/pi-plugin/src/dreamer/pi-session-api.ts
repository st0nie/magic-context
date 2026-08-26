import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Shared resolver for pi-coding-agent's session APIs, used by every Pi dreamer
 * provider that reads historical JSONL sessions (retrospective, refresh-primers).
 *
 * ONE resolver on purpose: the session-listing API drifted once already
 * (`SessionManager.listSessions` never existed publicly; listing is
 * `SessionManager.listAll`, and `loadEntriesFromFile` is not exported — entries
 * come from `readFileSync` + `parseSessionEntries`). When each provider carried
 * its own copy of this lookup, one copy got fixed and the other kept probing the
 * nonexistent API, so its feature silently degraded. Any future Pi API drift
 * should break exactly one resolver and one test.
 */
export interface PiSessionApi {
	listSessions: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile: (filePath: string) => unknown[] | Promise<unknown[]>;
}

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

export interface ModuleLoader {
	name: string;
	load: () => Promise<unknown>;
}

export const defaultLoaders: ModuleLoader[] = [
	{
		// Resolve from the running Pi binary FIRST so the dreamer loads the SAME
		// pi-coding-agent version that owns the live session format. A stale or
		// mismatched copy in an extension tree (e.g. a host peer that was
		// auto-installed once and never updated) can drift from the live session
		// API and break retrospective / refresh-primers.
		name: "Resolve from running Pi binary entry",
		load: async () => {
			if (!process.argv[1] && !process.execPath) {
				throw new Error(
					"Neither process.argv[1] nor process.execPath is available",
				);
			}
			// The Pi binary is spawned with `process.argv[1]` pointing at the host
			// `cli.js` (see subagent-runner resolvePiInvocation). But in a
			// packaged/single-file binary run, argv[1] is a CLI arg (e.g. `--print`),
			// and when Pi is launched via a bin shim, argv[1] may be a SYMLINK to the
			// real cli.js (node/bun preserve the invocation path). So resolve the real
			// entry first (realpathSync), then fall back to the interpreter binary
			// (process.execPath) when argv[1] is not an on-disk file at all.
			const entry =
				process.argv[1] && existsSync(process.argv[1])
					? realpathSync(process.argv[1])
					: process.execPath;
			// pi-coding-agent ships ESM-only exports (no "require" condition), so
			// createRequire(...).resolve("<pkg>") fails with
			// ERR_PACKAGE_PATH_NOT_EXPORTED. Walk up from the resolved entry to find
			// the package by name and import its ESM entry directly.
			let dir = dirname(entry);
			let found: { dir: string; pkg: Record<string, unknown> } | null = null;
			while (dir !== dirname(dir)) {
				const pkgJsonPath = join(dir, "package.json");
				if (existsSync(pkgJsonPath)) {
					try {
						const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
						if (pkg?.name === PI_CODING_AGENT_MODULE) {
							found = { dir, pkg };
							break;
						}
					} catch {
						// ignore unreadable/invalid package.json
					}
				}
				dir = dirname(dir);
			}
			if (!found) {
				// Use the resolved `entry` (which may have fallen back to
				// process.execPath when argv[1] is a CLI arg or absent), not
				// process.argv[1], so the message names the path actually walked
				// instead of interpolating `undefined`.
				throw new Error(
					`Could not locate ${PI_CODING_AGENT_MODULE} package.json from ${entry}`,
				);
			}
			const pkg = found.pkg as {
				exports?: { ".": { import?: string } } | undefined;
				module?: string;
				main?: string;
			};
			const entryRel = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main;
			if (!entryRel) {
				throw new Error(`No ESM entry found in ${found.dir}/package.json`);
			}
			return await import(pathToFileURL(join(found.dir, entryRel)).href);
		},
	},
	{
		name: "Bare import",
		load: async () => await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE),
	},
];

let cachedModulePromise: Promise<unknown> | null = null;

export function clearCachedModule(): void {
	cachedModulePromise = null;
}

export async function resolvePiCodingAgentModule(
	loaders?: ModuleLoader[],
): Promise<unknown> {
	if (cachedModulePromise) {
		return cachedModulePromise;
	}

	const activeLoaders = loaders ?? defaultLoaders;
	const promise = (async () => {
		const errors: Error[] = [];
		for (const loader of activeLoaders) {
			try {
				return await loader.load();
			} catch (err: unknown) {
				errors.push(err as Error);
			}
		}
		throw new Error(
			`Failed to resolve ${PI_CODING_AGENT_MODULE} via all strategies:\n` +
				errors
					.map((e, i) => `  - ${activeLoaders[i].name}: ${e.message || e}`)
					.join("\n") +
				"\nLikely cause: symlinked or nonstandard install layout.",
		);
	})();

	cachedModulePromise = promise;
	promise.catch(() => {
		if (cachedModulePromise === promise) {
			cachedModulePromise = null;
		}
	});

	return promise;
}

export async function loadDefaultPiSessionApi(
	loaders?: ModuleLoader[],
): Promise<PiSessionApi> {
	const mod = (await resolvePiCodingAgentModule(loaders)) as {
		SessionManager?: {
			listAll?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
		};
		loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
		parseSessionEntries?: (content: string) => unknown[];
	};
	const listSessions = mod.SessionManager?.listAll;
	if (typeof listSessions !== "function") {
		throw new Error(
			"Pi session APIs unavailable: expected SessionManager.listAll on pi-coding-agent",
		);
	}
	// loadEntriesFromFile is NOT part of pi-coding-agent's public API — fall back
	// to readFileSync + parseSessionEntries (both exported).
	const loadEntriesFromFile: PiSessionApi["loadEntriesFromFile"] =
		mod.loadEntriesFromFile ??
		((filePath: string) => {
			const content = readFileSync(filePath, "utf8");
			return mod.parseSessionEntries?.(content) ?? [];
		});
	return {
		listSessions: listSessions.bind(mod.SessionManager),
		loadEntriesFromFile,
	};
}
