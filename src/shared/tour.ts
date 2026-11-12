// The tour's routes: what `diffle tour` pushes and the tour view reads.
import { z } from 'zod';

/** The review's tour: one HTML document, as the agent last pushed it. */
export const TourSchema = z.object({
  html: z.string(),
  /** Milliseconds since the epoch. */
  pushedAt: z.number().int(),
});
export type Tour = z.infer<typeof TourSchema>;

/** `PUT /api/tour`: replaces the review's tour. */
export const TourPushSchema = z.object({ html: z.string() });
export type TourPush = z.infer<typeof TourPushSchema>;

/** `GET /api/tour`: the review's tour, or null without one. */
export const TourResponseSchema = z.object({ tour: TourSchema.nullable() });
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
 * order. A warning is a judgment call, such as a file note that may be long; the agent fixes it
 * or keeps it knowingly.
 */
export const TourPushedSchema = z.object({ tour: TourSchema, warnings: TourErrorSchema.array() });
export type TourPushed = z.infer<typeof TourPushedSchema>;

/** What `PUT /api/tour` answers with 422: every reason, in document order. */
export const TourRejectionSchema = z.object({ errors: TourErrorSchema.array() });
export type TourRejection = z.infer<typeof TourRejectionSchema>;
