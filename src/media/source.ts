import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny'

export interface Source {
  input: Input
  video: InputVideoTrack | null
  audio: InputAudioTrack | null
  duration: number
  width: number
  height: number
}

/** Opens a picked video file for reading; nothing is loaded into memory up front. */
export async function openSource(file: Blob): Promise<Source> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  if (!(await input.canRead())) {
    input.dispose()
    throw new Error("This file isn't a video HustlClip can read. Use an MP4, MOV, MKV or WebM file.")
  }
  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()
  if (video && !(await video.canDecode())) {
    input.dispose()
    throw new Error("This phone's browser can't decode this video. In Seal, choose MP4 (H.264) and download again.")
  }
  const duration = await input.computeDuration()
  const width = video ? await video.getDisplayWidth() : 0
  const height = video ? await video.getDisplayHeight() : 0
  return { input, video, audio, duration, width, height }
}
