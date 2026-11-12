// The tour's half of the contract: the elements a tour document is written in, what a thread on a
// tour names, and the tour's routes. It imports nothing from `protocol.ts`, which imports it, so the
// two modules never form a cycle.
import { z } from 'zod';
import { SideSchema } from './side.js';

/** A card's `id`. Letters, digits, `-` and `_`, starting with a letter. */
const tourIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
/** A positive integer, as an HTML attribute spells it. */
const tourNumberSchema = z.string().regex(/^[1-9][0-9]*$/);
/** A line range on one side, `40-58`, or one line, `40`. */
const tourLinesSchema = z.string().regex(/^[1-9][0-9]*(-[1-9][0-9]*)?$/);
/** A Lucide icon by its name on lucide.dev: `database`, `shield-check`. */
const tourIconNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * A framed explainer for one part of the diff, a block in the article's flow: its title, a sentence
 * or two, and the `diffle-diff`s it explains. It holds what prose holds, except headings and cards.
 */
export const TourCardSchema = z
  .object({
    tag: z.literal('diffle-card'),
    /** Unique in the tour. Letters, digits, `-` and `_`, starting with a letter. */
    id: tourIdSchema,
    /** What this part of the diff does, as the card's heading. */
    title: z.string().min(1),
    /** A Lucide icon before the title, by its name on lucide.dev. */
    icon: tourIconNameSchema.optional(),
  })
  .strict();

/**
 * A Lucide icon inside a line of text (prose, a heading, a table cell), at the text's size and
 * colour. It marks one kind of thing the same way throughout the tour. It holds nothing.
 */
export const TourIconSchema = z
  .object({
    tag: z.literal('diffle-icon'),
    /** Its name on lucide.dev: `database`, `shield-check`. */
    name: tourIconNameSchema,
    /** A colour in place of the text's: `accent`, or `success`, `warning` and `error` for status. */
    tone: z.enum(['accent', 'success', 'warning', 'error']).optional(),
  })
  .strict();

/** Lines of the review's diff, highlighted, with a jump to them. It holds nothing. */
export const TourDiffSchema = z
  .object({
    tag: z.literal('diffle-diff'),
    /** A file of the review, relative to the repository root; a renamed file by its new path. */
    path: z.string().min(1),
    /** Which side's line numbers `lines` counts: `old` (before) or `new` (after, the default). */
    side: SideSchema.optional(),
    /** The line range on that side, `40-58`, or one line, `40`. */
    lines: tourLinesSchema,
  })
  .strict();

/**
 * Lines of the review's diff walked one note at a time, a block in the article's flow: the reader
 * steps through its `diffle-note`s in order, and each lights its lines and dims the rest. It holds
 * only its notes.
 */
export const TourWalkSchema = z
  .object({
    tag: z.literal('diffle-walk'),
    /** A file of the review, relative to the repository root; a renamed file by its new path. */
    path: z.string().min(1),
    /** Which side's line numbers `lines` and its notes' `lines` count: `old` or `new` (the default). */
    side: SideSchema.optional(),
    /** The line range the walk shows, `12-30`. */
    lines: tourLinesSchema,
  })
  .strict();

/**
 * One step of a `diffle-walk` or a stepped `diffle-diagram`: a title and a sentence or two, in
 * inline prose (`code`, `strong`, `em`, `a`, `diffle-symbol`, `diffle-jump`, `diffle-icon`).
 */
export const TourNoteSchema = z
  .object({
    tag: z.literal('diffle-note'),
    /** In a walk, the lines it explains, within the walk's, on its side: `14-17`, or `14`. A diagram's note takes none: it explains the step of its number. */
    lines: tourLinesSchema.optional(),
    /** What these lines do, in a few words: `Record each sale`. */
    title: z.string().min(1),
  })
  .strict();

/**
 * A path through the code in call order, a block in the article's flow: the reader steps through
 * its `diffle-stop`s, each a few lines of a file around one line, lit, with a sentence. It holds
 * only its stops.
 */
export const TourTraceSchema = z
  .object({
    tag: z.literal('diffle-trace'),
  })
  .strict();

/**
 * One stop of a `diffle-trace`: a line of a file of the review and a sentence about what happens
 * there, in inline prose (`code`, `strong`, `em`, `a`, `diffle-symbol`, `diffle-jump`, `diffle-icon`).
 */
export const TourStopSchema = z
  .object({
    tag: z.literal('diffle-stop'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line the stop lights; a few lines around it show too. */
    line: tourNumberSchema,
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/**
 * Two to four panes side by side in one block's width, one shown at a time: the chosen design next
 * to one it rejected, a payload before and after. It holds only its `diffle-tab`s.
 */
export const TourTabsSchema = z
  .object({
    tag: z.literal('diffle-tabs'),
  })
  .strict();

/** What a tab's pane is to the reader, shown as a chip beside its title. */
export const TourTabKindSchema = z.enum(['chosen', 'rejected', 'example']);
export type TourTabKind = z.infer<typeof TourTabKindSchema>;

/** One pane of a `diffle-tabs`. It holds what a card holds: prose and blocks, no headings or other tabs. */
export const TourTabSchema = z
  .object({
    tag: z.literal('diffle-tab'),
    /** What the pane shows, in a few words, on its tab. */
    title: z.string().min(1),
    /** A chip beside the title: `chosen`, `rejected` or `example`. */
    kind: TourTabKindSchema.optional(),
  })
  .strict();

/**
 * Questions the reviewer decides, a block in the article's flow: each `diffle-item` is ticked as
 * decided or answered in a thread the agent reads. It holds only its items.
 */
export const TourCheckSchema = z
  .object({
    tag: z.literal('diffle-check'),
  })
  .strict();

/** A question of a `diffle-check`, one line of inline prose: what the reviewer should decide. */
export const TourItemSchema = z
  .object({
    tag: z.literal('diffle-item'),
    /** A sentence of context under the question: what the choice costs or what it rests on. */
    context: z.string().min(1).optional(),
  })
  .strict();

/** A language the highlighter knows, by its id: `rust`, `typescript`, `python`. */
const tourLangSchema = z.string().regex(/^[a-z0-9][a-z0-9+#-]*$/);

/**
 * Code the agent writes: signatures, interfaces, type definitions, the shape of an abstraction,
 * never code the diff already shows. Highlighted like the diff; with `path`, framed with the file's
 * path and a jump to it. With `example`, a snippet the agent made up to show how something works
 * (data as it flows, a simplified spike, an alternative design), labelled as an example. It holds
 * its code as text, `<` written `&lt;`.
 */
export const TourCodeSchema = z
  .object({
    tag: z.literal('diffle-code'),
    /** The highlighter's language; required without `path`, which otherwise names it. */
    lang: tourLangSchema.optional(),
    /** The file of the review the code comes from, relative to the repository root. */
    path: z.string().min(1).optional(),
    /** Where in `path`, on the new side, its first declaration sits. */
    line: tourNumberSchema.optional(),
    /** Written bare, as an HTML boolean attribute: the code is made up, not from the repository. It takes no `path` or `line`. */
    example: z.string().optional(),
    /** What an example shows, beside its label: `Response to POST /login`. */
    title: z.string().min(1).optional(),
  })
  .strict();

/**
 * A directory tree of some files under a title; changed ones show their status and line counts. It
 * holds only `diffle-file` notes, on a few of its files.
 */
export const TourTreeSchema = z
  .object({
    tag: z.literal('diffle-tree'),
    /** What its files are, in a few words, as its header: `Server · Rust`. */
    title: z.string().min(1),
    /** A Lucide icon before the title, by its name on lucide.dev. */
    icon: tourIconNameSchema.optional(),
    /** Files of the review, one per line, relative to the repository root. */
    paths: z.string().min(1),
    /** The folder the tree starts at, without a trailing `/`; every path lies under it. Default: the repository root. */
    root: z.string().min(1).optional(),
  })
  .strict();

/**
 * A note beside one file of its `diffle-tree`: a few words of inline prose on where to start or what
 * surprises, never the file's name again.
 */
export const TourFileSchema = z
  .object({
    tag: z.literal('diffle-file'),
    /** One of its tree's `paths`. */
    path: z.string().min(1),
  })
  .strict();

/**
 * A button that opens the diff view at a file or a line. Its text is the label, plain text: markup
 * inside it is refused. Empty, it shows `path:line`.
 */
export const TourJumpSchema = z
  .object({
    tag: z.literal('diffle-jump'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line to land on; without it, the file's first change. */
    line: tourNumberSchema.optional(),
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/**
 * A symbol the prose names, anchored to its line: coloured as the diff colours it there, with the
 * diff's hover card and a click that lists its references when a language server serves its file.
 * It holds nothing.
 */
export const TourSymbolSchema = z
  .object({
    tag: z.literal('diffle-symbol'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line `name` is on. */
    line: tourNumberSchema,
    /** The symbol, exactly as it appears on that line. */
    name: z.string().min(1),
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/** A highlighted aside, a block in the article's flow or in a card. It holds what a card holds, except another callout. */
export const TourCalloutSchema = z
  .object({
    tag: z.literal('diffle-callout'),
    /** `info` for context, `warning` for something the reviewer should check, `danger` for a likely bug or breaking change. */
    kind: z.enum(['info', 'warning', 'danger']),
  })
  .strict();

/**
 * A simple architecture diagram, a block in the article's flow: one inline `<svg>` of
 * `TourSvgElement`s, drawn by hand; with steps, a `diffle-note` per step after it.
 */
export const TourDiagramSchema = z
  .object({
    tag: z.literal('diffle-diagram'),
  })
  .strict();

/** A coordinate or length in diagram units; one unit is one pixel. */
const svgNumberSchema = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** Coordinate pairs, `x,y x,y ...`. */
const svgPointsSchema = z.string().regex(/^[0-9.,\s-]+$/);
/** A path's commands and numbers, such as `M168 116 H240`. */
const svgPathSchema = z.string().regex(/^[MmLlHhVvCcSsQqZz0-9.,\s-]+$/);
/** Words of `TourSvgClass`, separated by spaces. */
const svgClassSchema = z.string();

/**
 * An element of a diagram's `<svg>`, with its geometry. diffle styles each from its classes and the
 * theme and draws the arrowheads, so none takes `style`, `fill`, `stroke`, fonts or markers.
 */
export const TourSvgElementSchema = z.discriminatedUnion('tag', [
  z
    .object({
      tag: z.literal('svg'),
      /** `0 0 <width> <height>`; one unit is one pixel. */
      viewBox: z.string().regex(/^0 0 [1-9][0-9]* [1-9][0-9]*$/),
    })
    .strict(),
  z
    .object({
      tag: z.literal('g'),
      class: svgClassSchema.optional(),
      /** The step of a stepped diagram that lights this group; the diagram holds one `diffle-note` per step. */
      step: tourNumberSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('rect'),
      x: svgNumberSchema,
      y: svgNumberSchema,
      width: svgNumberSchema,
      height: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('circle'),
      cx: svgNumberSchema,
      cy: svgNumberSchema,
      r: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('ellipse'),
      cx: svgNumberSchema,
      cy: svgNumberSchema,
      rx: svgNumberSchema,
      ry: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z.object({ tag: z.literal('polygon'), points: svgPointsSchema, class: svgClassSchema.optional() }).strict(),
  z.object({ tag: z.literal('polyline'), points: svgPointsSchema, class: svgClassSchema.optional() }).strict(),
  z.object({ tag: z.literal('path'), d: svgPathSchema, class: svgClassSchema.optional() }).strict(),
  z
    .object({
      tag: z.literal('line'),
      x1: svgNumberSchema,
      y1: svgNumberSchema,
      x2: svgNumberSchema,
      y2: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('text'),
      x: svgNumberSchema,
      y: svgNumberSchema,
      class: svgClassSchema.optional(),
      /** With the class `code`: the highlighter's language for its lines, one `tspan` each. */
      lang: tourLangSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('tspan'),
      x: svgNumberSchema.optional(),
      y: svgNumberSchema.optional(),
      dx: svgNumberSchema.optional(),
      dy: svgNumberSchema.optional(),
      class: svgClassSchema.optional(),
    })
    .strict(),
]);
export type TourSvgElement = z.infer<typeof TourSvgElementSchema>;

/**
 * A Lucide icon in a diagram: an `<svg>` nested in the drawing, holding nothing. It takes its text's
 * colour, or the tone of its group or its own class.
 */
export const TourSvgIconSchema = z
  .object({
    tag: z.literal('svg'),
    /** Its name on lucide.dev: `database`, `shield-check`. */
    'data-lucide': tourIconNameSchema,
    /** Its top-left corner. */
    x: svgNumberSchema,
    y: svgNumberSchema,
    /** Its width and height; 14 by default. */
    size: svgNumberSchema.optional(),
    class: svgClassSchema.optional(),
  })
  .strict();
export type TourSvgIcon = z.infer<typeof TourSvgIconSchema>;

/**
 * The classes that style a diagram. Lines: `arrow` (a head at the end), `arrows` (both ends),
 * `dashed`. Text: `bold`, `small`, `mono`, `code` (lines of code in its `lang`, one `tspan` each,
 * highlighted), `c` (centred on `x`), `e` (ends at `x`), `eyebrow` (a region's label). Surfaces: `fill` (a gray face), `frame` (a dashed container without a face).
 * Tones, on a shape, group, line or text: `accent` for what the point is about, `success`,
 * `warning` and `error` for status.
 */
export const TourSvgClassSchema = z.enum([
  'arrow',
  'arrows',
  'dashed',
  'bold',
  'small',
  'mono',
  'code',
  'c',
  'e',
  'eyebrow',
  'fill',
  'frame',
  'accent',
  'success',
  'warning',
  'error',
]);
export type TourSvgClass = z.infer<typeof TourSvgClassSchema>;

/**
 * Two or three columns side by side while the window has room, stacked below that, at the top
 * level. Each column is a block (`diffle-card`, `diffle-code`, `diffle-diff`, `diffle-diagram`, `diffle-tree`,
 * `diffle-callout`, `table`) or short prose (`div`, `p`, `ul`, `ol`).
 */
export const TourRowSchema = z
  .object({
    tag: z.literal('diffle-row'),
  })
  .strict();

// Keep each member `.strict()`: typify turns that into `deny_unknown_fields`, which is how the
// validator refuses an unknown attribute.
/** A `diffle-*` element of a tour with its attributes, which are strings as in HTML. */
export const TourElementSchema = z.discriminatedUnion('tag', [
  TourCardSchema,
  TourDiffSchema,
  TourTreeSchema,
  TourJumpSchema,
  TourSymbolSchema,
  TourCalloutSchema,
  TourDiagramSchema,
  TourRowSchema,
  TourCodeSchema,
  TourIconSchema,
  TourWalkSchema,
  TourNoteSchema,
  TourTraceSchema,
  TourStopSchema,
  TourTabsSchema,
  TourTabSchema,
  TourCheckSchema,
  TourItemSchema,
  TourFileSchema,
]);
export type TourElement = z.infer<typeof TourElementSchema>;
export type TourElementTag = TourElement['tag'];

/**
 * The plain tags a tour is written in: `h1` titles it, each `h2` starts a section, a step of the
 * walk, and `h3` a subsection; `h4` is a small heading inside a card, a tab, a callout or a
 * `details`, where those cannot go. The rest carry prose, lists and tables, and `details` folds away
 * what the main path can do without, opening with its `summary`. They take no
 * attributes, except `a`, which takes an `href` to an `http(s)` URL, and `th` and `td`, which take
 * `colspan` and `rowspan` as positive numbers.
 */
export const TourTagSchema = z.enum([
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'strong',
  'em',
  'a',
  'div',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
export type TourTag = z.infer<typeof TourTagSchema>;

/**
 * Every tag a thread on the tour can name: a plain tag or a `diffle-*` element holding the words it
 * quotes, a block it is on as a whole, or a diagram's box (`rect`) or label (`text`).
 */
export const TourCommentTagSchema = z.enum([
  ...new Set([
    ...TourTagSchema.options,
    ...TourElementSchema.options.map((element) => element.shape.tag.value),
    'rect' as const,
    'text' as const,
  ]),
] as [TourTag | TourElementTag | 'rect' | 'text', ...(TourTag | TourElementTag | 'rect' | 'text')[]]);
export type TourCommentTag = z.infer<typeof TourCommentTagSchema>;

/** The tags a thread may sit on as a whole: blocks, and a diagram's boxes and labels. */
export const TourWholeTagSchema = TourCommentTagSchema.extract([
  'diffle-card',
  'diffle-diff',
  'diffle-walk',
  'diffle-trace',
  'diffle-tabs',
  'diffle-check',
  'diffle-item',
  'diffle-code',
  'diffle-tree',
  'diffle-callout',
  'diffle-diagram',
  'table',
  'rect',
  'text',
]);
export type TourWholeTag = z.infer<typeof TourWholeTagSchema>;

/** The blocks whose content is code or a drawing, not reading text: a selection in them quotes nothing. */
export const TourOpaqueTagSchema = TourWholeTagSchema.extract([
  'diffle-diff',
  'diffle-code',
  'diffle-tree',
  'diffle-diagram',
]);
export type TourOpaqueTag = z.infer<typeof TourOpaqueTagSchema>;

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
