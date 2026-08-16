import {
  requestRuntimeImagePreparation,
  type RuntimeImagePullTask,
} from "./runtime-images.js";

export type RuntimeImagePreparationRequest = typeof requestRuntimeImagePreparation;

export async function activateRuntimeImageConfiguration<T>(input: {
  refs: readonly { image_key: string; image_ref: string }[];
  purpose: string;
  persist: () => Promise<T>;
  requestPreparation?: RuntimeImagePreparationRequest;
}): Promise<
  | { status: "preparing"; saved: false; task: RuntimeImagePullTask }
  | { status: "saved"; saved: true; value: T }
> {
  const preparation = await (input.requestPreparation ?? requestRuntimeImagePreparation)(input.refs, input.purpose);
  if (!preparation.ready) return { status: "preparing", saved: false, task: preparation.task };
  return { status: "saved", saved: true, value: await input.persist() };
}
