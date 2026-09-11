/**
 * The shipped decoder, as a candidate module.
 *
 * Every cycle needs a control, and the control has to travel the same road as
 * the candidates: the same frame delivery, the same availability stamping, the
 * same scoring path. A control that were special-cased inside the runner would
 * be a second implementation of the pipeline, and the one number every result
 * is compared against would be the one number produced differently.
 *
 * So the control is a module like any other. It wraps the production decoder
 * rather than restating it, which is what makes it the shipped behaviour and not
 * a reimplementation that happens to agree today.
 *
 * It is prepared infrastructure, fixed for the duration of a run, and it takes
 * no parameters: there is nothing about the shipped baseline to configure.
 */

import { OnlineAmtOutputDecoder } from "../../index.js";
import {
  experimentOnlyKeys,
  type ExperimentCandidateEvent,
  type ExperimentDecoder,
  type ExperimentDecoderModule,
  type ExperimentFrame,
} from "./types.js";

const shipped: ExperimentDecoderModule = {
  id: "shipped",
  summary: "The production decoder's own transition events, emitted on the frame that produced them.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, []);
    return {};
  },

  createDecoder(): ExperimentDecoder {
    const decoder = new OnlineAmtOutputDecoder();
    return {
      onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] {
        const decoded = decoder.decode(
          frame.weightedScores,
          frame.selectedStates,
          frame.signalActive,
          frame.capturedAtMs,
        );
        return decoded.noteEvents
          .filter((event) => event.type !== "offset")
          .map((event) => ({
            midi: event.midi,
            originFrameIndex: frame.index,
            reportedKind: event.type,
          }));
      },
    };
  },
};

export default shipped;
