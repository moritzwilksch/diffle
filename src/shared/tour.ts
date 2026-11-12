// What a thread on a tour names, a checklist item, and the tour's routes. It imports nothing from
// `protocol.ts`, which imports it, so the two modules never form a cycle.
import { z } from 'zod';
import { TourCommentTagSchema } from './tour-catalog.js';

/** A selection in a tour element's reading text: what the reader sees, as `diffle --skill` defines it. */
export const TourTextTargetSchema = z.object({
  on: z.literal('text'),
  /** The selected text, whitespace runs collapsed to one space. */
  quoted: z.string(),
  /** Which match of `quoted` in the element's reading text, 0-based, whitespace ignored. */
  occurrence: z.number().int(),
});
export type TourTextTarget = z.infer<typeof TourTextTargetSchema>;

/** A tour element as a whole: a block, a diagram box or a diagram label. */
export const TourElementTargetSchema = z.object({
  on: z.literal('element'),
  /** What finds it again: a card's title, a box's text, a diff's path and lines; '' for none. */
  label: z.string(),
});
export type TourElementTarget = z.infer<typeof TourElementTargetSchema>;

/** The part of a tour element a thread is on. */
export const TourTargetSchema = z.discriminatedUnion('on', [TourTextTargetSchema, TourElementTargetSchema]);
export type TourTarget = z.infer<typeof TourTargetSchema>;

/** The part of a tour element a new thread is on; the server labels an element. */
export const TourTargetRequestSchema = z.discriminatedUnion('on', [
  TourTextTargetSchema,
  z.object({ on: z.literal('element') }),
]);
export type TourTargetRequest = z.infer<typeof TourTargetRequestSchema>;

/** A tour element by its tag and the one handle an agent can search its document for, in full. */
export const TourPartSchema = z.object({
  /** Its tag: `diffle-card`, `p`, a diagram's `rect`. */
  tag: TourCommentTagSchema,
  /**
   * What names it: a card's `id`; a diff's or a walk's `path:lines`; a stop's or a code block's
   * `path:line`; a note's, a tab's or a tree's `title`; a callout's `kind`. Absent when it has none.
   */
  handle: z.string().optional(),
});
export type TourPart = z.infer<typeof TourPartSchema>;

/** A thread on the review's tour, at the element `node` names and the part of it `target` names. */
export const TourAnchorSchema = z.object({
  kind: z.literal('tour'),
  /** Child-element indices from the document's `<body>` to the element, in the tour as last pushed. */
  node: z.number().int().array(),
  /** The 1-based number of the `h2` section it sits in; absent before the first. */
  step: z.number().int().optional(),
  /** That section's heading text; '' before the first. */
  section: z.string(),
  /** The element the thread is on. */
  element: TourPartSchema,
  /** The innermost card, tab or walk holding it, or the diagram holding a diagram's note. */
  within: TourPartSchema.optional(),
  target: TourTargetSchema,
});
export type TourAnchor = z.infer<typeof TourAnchorSchema>;

/**
 * `POST /api/tour/threads`: opens a thread on the review's tour as it is now. The server names the
 * section and the element, and an element's label, from the stored tour.
 */
export const TourThreadCreateSchema = z.object({
  node: z.number().int().array(),
  target: TourTargetRequestSchema,
  body: z.string().refine((body) => body.trim().length > 0, 'body required'),
});
export type TourThreadCreate = z.infer<typeof TourThreadCreateSchema>;

/** An item of a `diffle-check` in the stored tour, with what the reviewer did with it. */
export const TourCheckItemSchema = z.object({
  /** Child-element indices from `<body>` to the item, as a tour anchor's `node`. */
  node: z.number().int().array(),
  /** The `h2` it sits under: its 1-based number; absent before the first. */
  step: z.number().int().optional(),
  section: z.string(),
  /** Its reading text, whitespace collapsed: what finds it again in a revised tour. */
  question: z.string(),
  /** Whether the reviewer ticked it as decided. */
  ticked: z.boolean(),
  /** The open thread that answers it, when there is one. */
  thread: z.string().optional(),
});
export type TourCheckItem = z.infer<typeof TourCheckItemSchema>;

/** The review's tour: one HTML document, as the agent last pushed it. */
export const TourSchema = z.object({
  html: z.string(),
  /** Milliseconds since the epoch. */
  pushedAt: z.number().int(),
});
export type Tour = z.infer<typeof TourSchema>;

/**
 * `PUT /api/tour/ticks`: ticks a checklist item as decided, or unticks it. An item is named by its
 * `TourCheckItem.question`, which a tour asks once, so a tick outlives a push that still asks it.
 */
export const TourTickSchema = z.object({ question: z.string(), ticked: z.boolean() });
export type TourTick = z.infer<typeof TourTickSchema>;

/** `PUT /api/tour`: replaces the review's tour. */
export const TourPushSchema = z.object({ html: z.string() });
export type TourPush = z.infer<typeof TourPushSchema>;

/** `GET /api/tour`: the review's tour, or null without one. */
export const TourResponseSchema = z.object({
  tour: TourSchema.nullable(),
  /** Its checklists' items in document order. */
  checks: TourCheckItemSchema.array(),
});
export type TourResponse = z.infer<typeof TourResponseSchema>;

/** One reason a pushed tour was refused, or one warning about an accepted one. */
export const TourErrorSchema = z.object({
  /** The culprit as the document spells it, with the card it sits in: `diffle-card#auth > diffle-diff path="a.rs"`. */
  element: z.string(),
  message: z.string(),
});
export type TourError = z.infer<typeof TourErrorSchema>;

/**
 * What `PUT /api/tour` answers for an accepted tour: the tour as stored, and warnings in document
 * order. A warning is a judgment call, such as a diagram label that may run past its box; the
 * agent fixes it or keeps it knowingly.
 */
export const TourPushedSchema = z.object({ tour: TourSchema, warnings: TourErrorSchema.array() });
export type TourPushed = z.infer<typeof TourPushedSchema>;

/** What `PUT /api/tour` answers with 422: every reason, in document order. */
export const TourRejectionSchema = z.object({ errors: TourErrorSchema.array() });
export type TourRejection = z.infer<typeof TourRejectionSchema>;
