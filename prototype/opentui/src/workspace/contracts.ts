import type { BoxRenderable, CliRenderer } from "@opentui/core";
import type { ParsedStatus } from "../status.js";
import type { ThemeName } from "../theme.js";

export const RPC_VERSION = 1;
export const ROUTES = ["now-playing", "queue", "library", "search", "browse", "playlists", "podcasts", "radio", "arcs", "settings", "help", "cast"] as const;
export type Route = typeof ROUTES[number];
export type Params = Record<string, unknown>;
export interface Row {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  detail?: string;
  uri?: string;
  duration_ms?: number;
  saved?: boolean;
  meta?: Params;
}
export interface Page<T = Row> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
  source?: string;
  revision?: string;
  refresh_available?: boolean;
}
export interface RpcApi {
  call<T = unknown>(method: string, params?: Params): Promise<T>;
}
export interface ScreenKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
  hyper?: boolean;
}
export interface ScreenContext {
  renderer: CliRenderer;
  api: RpcApi;
  theme(): ThemeName;
  setTheme(theme: ThemeName): void;
  reducedMotion(): boolean;
  setReducedMotion(value: boolean): void;
  status(): ParsedStatus | null;
  onStatus(listener: (status: ParsedStatus) => void): () => void;
  navigate(route: Route, params?: Params): void;
  notify(message: string): void;
}
export interface Screen {
  root: BoxRenderable;
  title: string;
  handleKey(key: ScreenKey): boolean;
  /** True while typing, so global letter shortcuts do not steal input. */
  editing?(): boolean;
  refresh(): void | Promise<void>;
  setTheme(theme: ThemeName): void;
  dispose(): void;
}
export type ScreenFactory = (context: ScreenContext, params?: Params) => Screen;

/** API vocabulary: all requests are newline JSON {protocol:"resonance",version:1,id,method,params}.
 * Responses carry {protocol,version,id,instance_id,ok,result} or {ok:false,error:{code,message}}.
 * Existing untagged status broadcasts remain compatible with the original IPC client.
 * Methods:
 * session.info -> {instance_id,version,capabilities:string[]}
 * player.action {action:"play_pause"|"previous"|"previous_or_restart"|"next"|"undo_skip"|"stop"|"seek"|"seek_relative"|"volume"|"volume_relative"|"repeat"|"shuffle"|"play",value?,uri?}
 * player.artwork {uri?,width?:1..40,height?:1..20} -> {available,uri,width,height,pixels?:string[],reason?}; two RGB pixel rows per terminal row
 * audio.subscribe {fps?:1..60,bands?:0..128,waveform?:0..512} -> {subscribed,fps,bands,waveform}; this connection then also gets
 *   {audio:{live,bands,waveform,level,pulse,beats,tempo}} lines at fps while sound plays. audio.unsubscribe -> {subscribed:false}
 * song.map {uri?} -> {uri,duration_ms,buckets,heard,level,bass,mid,treble}; each lane has `buckets` values 0..1, null where unheard
 * queue.list {offset?,limit?} -> Page (row.id is an entry identity, meta.index/current; revision)
 * queue.action {action:"play"|"remove"|"move"|"clear"|"append"|"play_next"|"save",entry_id?,revision?,to?,uri?,name?}
 * library.list {kind:"tracks"|"albums"|"artists"|"playlists"|"shows"|"browse",offset?,limit?,filter?,sort?} -> Page
 * library.detail {kind,id,uri?,offset?,limit?} -> Page
 * library.action {action:"save"|"unsave"|"refresh",kind?,id?,uri?}
 * search {query,kind?,offset?,limit?} -> Page
 * playlist.action {action:"create"|"rename"|"add"|"remove"|"delete",id?,name?,uri?,position?}
 * radio.status -> {active,waiting,seed,seed_track,discovery,played_count,cache_tracks,catalog_tracks,queue_mode,parked_count,radio_pending_count,explicit_pending_count,...}
 * radio.action {action:"start"|"stop"|"discovery",value?,uri?}
 * radio.debug {limit?,rng_seed?} -> structured local diagnostic report
 * builder.state -> {presets,recipe,draft|null,fingerprinted,current,seeds,saved}
 * builder.build {recipe?} -> ArcDraft {recipe,slots,targets,confidence,measured,estimated,unmeasured,pool_size,duration_ms,notes,playlist_id}
 * builder.reroll {slot} -> {slot,alternatives}; builder.choose {slot,uri} / builder.pin {slot,pinned} / builder.ban {slot} -> ArcDraft
 * builder.play {slot?} -> {queued,slot}; builder.save {name,public?,overwrite?} -> {id,uri,overwritten,tracks}; builder.coverage -> {fingerprinted,previewed,catalog_measured,catalog_previewed,catalog_tracks,preview_lookup,preview_pending}
 * settings.get -> {values:Record<string,unknown>,bindings:Record<string,string>}
 * settings.action {action:"reload"|"reconnect"|"logout"|"command",command?}
 * cast.list -> Page; cast.action {action:"connect"|"disconnect",id?}
 * share {uri} -> {url}; endpoints never return credentials.
 */
