/** Bind the SDK's remote stream to the browser's actual playback device. */
export async function playRemoteStream(element: HTMLAudioElement, stream: MediaStream, outputId: string) {
  element.srcObject = stream;
  const sink = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sink.setSinkId) await sink.setSinkId(outputId);
  // Reject to the caller so autoplay/device failures can be shown and retried by a click.
  await element.play();
}

export function clearRemoteStream(element: HTMLAudioElement | null) {
  if (!element) return;
  element.pause();
  element.srcObject = null;
}
