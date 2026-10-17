// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. This file registers exactly one
// handler per manifest operation id, plus the agent first-sight event. Op ids and input/output types come from the
// kit that `tb-gen kit` generates from the manifest (`#kit`, built by `node --run kit`); none is written by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type SdkAppDefinition } from "@opt2-tealbrick/miniapp-sdk";
import { type ItemCreateInput, type ItemCreateOutput, type ItemsListInput, type ItemsListOutput, OP, type OpId } from "#kit";
import { COLLECTION, createItem, listItems } from "./items.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

export const handlers = {
  [OP.itemsList]: op<ItemsListInput, ItemsListOutput>({
    // A named collection is access-checked by the SDK; null = across collections, so `run` filters to readable ones.
    scope: (input) => input.collection ?? null,
    async run(input, ctx) {
      const collections = input.collection ? [input.collection] : await ctx.scope.readable(COLLECTION);
      return { items: listItems(ctx.db, collections, input.limit ?? 50) };
    },
  }),
  [OP.itemCreate]: op<ItemCreateInput, ItemCreateOutput>({
    // Default target: the caller's own collection (created in events.agentAdded; manifest defaultGrants "own").
    // Idempotency (manifest "required") is the SDK's: a repeated key returns the stored result without calling run.
    scope: (input, caller) => input.collection ?? caller.id,
    async run(input, ctx) {
      const item = createItem(ctx.db, { collection: input.collection ?? ctx.caller.id, title: input.title, createdBy: ctx.caller.id });
      return { id: item.id, collection: item.collection };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  events: {
    // First sight of an agent (SDK-API §7.2): create its own collection; the SDK then applies defaultGrants.
    async agentAdded(agent, ctx) {
      await ctx.scopes.instances.create(COLLECTION, agent.id, `${agent.name} items`.slice(0, 80), { ownerAgent: agent.id });
    },
  },
};

export const app = defineApp(definition);
