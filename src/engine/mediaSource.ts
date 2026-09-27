/**
 * Where a media file's bytes come from. Usually a Blob (a file picked in the
 * browser, or the copy kept in browser storage); in the desktop app, files are
 * used in place and read over a local URL with range requests, so even huge
 * recordings are never copied or loaded into memory.
 */
import { BlobSource, UrlSource, type Source } from 'mediabunny';

export interface RemoteData { url: string; size: number }
export type MediaData = Blob | RemoteData;

export function isRemote(d: MediaData): d is RemoteData {
  return typeof Blob === 'undefined' || !(d instanceof Blob);
}

export function toSource(d: MediaData): Source {
  return isRemote(d) ? new UrlSource(d.url) : new BlobSource(d);
}

export function dataSize(d: MediaData): number {
  return isRemote(d) ? d.size : d.size;
}
