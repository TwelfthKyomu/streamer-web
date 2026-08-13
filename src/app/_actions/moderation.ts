"use server";

import { revalidatePath } from "next/cache";
import {
  ForbiddenError,
  requireModerator,
  UnauthorizedError,
} from "@/modules/auth";
import { type DecisionOutcome, decide } from "@/modules/moderation";

export async function decideAction(params: {
  postId: string;
  approve: boolean;
}): Promise<DecisionOutcome> {
  try {
    const moderator = await requireModerator();
    const outcome = await decide({
      postId: params.postId,
      moderatorId: moderator.id,
      approve: params.approve,
    });

    if (outcome.status === "ok") {
      revalidatePath("/moderation");
      revalidatePath("/");
    }

    return outcome;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof UnauthorizedError) {
      return { status: "not_found" };
    }
    throw error;
  }
}
