/**
 * YouTube's own ⋮ menu for a video, as the command YouTube's ⋮ buttons carry: a sheet listing
 * Add to queue, Save to Watch Later, Save to playlist, Download, Share and Report. Built from
 * the video ID alone, in exactly the shapes YouTube's home feed uses (checked signed in, live,
 * Oct 2026), and opened by YouTube's own app (bridge-main.ts) next to our ⋮ button. So it is
 * YouTube's real menu: its playlist picker, Premium download, report form, toasts and sign-in
 * prompts. Our own feed actions are added to the same sheet and intercepted (home.ts).
 */
type Command = Record<string, unknown>;

/** One of our own items in YouTube's sheet: shown with YouTube's icon, handled by us. */
export interface OwnMenuItem {
  title: string;
  /** YouTube icon name, e.g. HIDE or REMOVE. */
  icon: string;
}

const bytes = (s: string) => [...new TextEncoder().encode(s)];

/** Length-delimited protobuf field. Lengths here are always < 128, so one byte is enough. */
const field = (tag: number[], body: number[]) => [...tag, body.length, ...body];

/** URL-safe base64 with "=" escaped, as YouTube writes most params. */
function urlBase64(b: number[]): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '%3D');
}

/** Plain base64 with "=" escaped (YouTube's serializedShareEntity). */
function plainBase64(b: number[]): string {
  return btoa(String.fromCharCode(...b)).replace(/=/g, '%3D');
}

const post = (apiUrl?: string) => ({ commandMetadata: { webCommandMetadata: { sendPost: true, ...(apiUrl ? { apiUrl } : {}) } } });

const item = (title: string, icon: string, command: Command) => ({
  listItemViewModel: {
    title: { content: title },
    leadingImage: { sources: [{ clientResource: { imageName: icon } }] },
    rendererContext: { commandContext: { onTap: { innertubeCommand: command } } },
  },
});

/** Does nothing if it ever runs: our own items are intercepted before YouTube sees the tap. */
const NOOP: Command = { signalServiceEndpoint: { signal: 'CLIENT_SIGNAL', actions: [] } };

export const ytCommands = {
  queue: (videoId: string): Command => ({
    ...post(),
    signalServiceEndpoint: {
      signal: 'CLIENT_SIGNAL',
      actions: [
        {
          addToPlaylistCommand: {
            openMiniplayer: true,
            videoId,
            listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
            onCreateListCommand: { ...post('/youtubei/v1/playlist/create'), createPlaylistServiceEndpoint: { videoIds: [videoId], params: 'CAQ%3D' } },
            videoIds: [videoId],
            videoCommand: {
              commandMetadata: { webCommandMetadata: { url: `/watch?v=${videoId}`, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
              watchEndpoint: { videoId },
            },
          },
        },
      ],
    },
  }),
  watchLater: (videoId: string): Command => ({
    ...post('/youtubei/v1/browse/edit_playlist'),
    playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }] },
  }),
  /** Opens the playlist picker inside the menu sheet; params = field 111 { field 1: video ID }. */
  playlist: (videoId: string): Command => ({
    commandMetadata: { interactionLoggingCommandMetadata: { screenVisualElement: { uiType: 264491 } } },
    showSheetCommand: {
      panelLoadingStrategy: {
        requestTemplate: { panelId: 'PAadd_to_playlist', params: urlBase64(field([0xfa, 0x06], field([0x0a], bytes(videoId)))) },
        screenVe: 264491,
      },
      contextualSheetPresentationConfig: { expandToFullWidth: true },
    },
  }),
  download: (videoId: string): Command => ({
    offlineVideoEndpoint: { videoId, onAddCommand: { getDownloadActionCommand: { videoId, params: 'CAIQAA%3D%3D', isCrossDeviceDownload: false } } },
  }),
  share: (videoId: string): Command => ({
    ...post('/youtubei/v1/share/get_share_panel'),
    shareEntityServiceEndpoint: {
      serializedShareEntity: plainBase64(field([0x0a], bytes(videoId))),
      commands: [{ openPopupAction: { popup: { unifiedSharePanelRenderer: { showLoadingSpinner: true } }, popupType: 'DIALOG', beReused: true } }],
    },
  }),
  /** params = field 2: video ID, then the fixed options YouTube sends for a video report. */
  report: (videoId: string): Command => ({
    ...post('/youtubei/v1/flag/get_form'),
    getReportFormEndpoint: {
      params: urlBase64([...field([0x12], bytes(videoId)), 0x40, 0x01, 0x58, 0x00, 0x70, 0x01, 0x78, 0x02, 0xd8, 0x01, 0x00, 0xe8, 0x01, 0x00]),
    },
  }),
};

/**
 * The ⋮ command: YouTube's items in YouTube's order, our own items before Report (where
 * YouTube puts its "Not interested" and "Don't recommend channel").
 */
export function ytMenuCommand(videoId: string, own: OwnMenuItem[]): Command {
  return {
    showSheetCommand: {
      panelLoadingStrategy: {
        inlineContent: {
          sheetViewModel: {
            content: {
              listViewModel: {
                listItems: [
                  item('Add to queue', 'ADD_TO_QUEUE_TAIL', ytCommands.queue(videoId)),
                  item('Save to Watch Later', 'WATCH_LATER', ytCommands.watchLater(videoId)),
                  item('Save to playlist', 'BOOKMARK_BORDER', ytCommands.playlist(videoId)),
                  // YouTube's own download item: it knows whether the user has Premium.
                  { downloadListItemViewModel: { rendererContext: { commandContext: { onTap: { innertubeCommand: ytCommands.download(videoId) } } } } },
                  item('Share', 'SHARE', ytCommands.share(videoId)),
                  ...own.map((o) => item(o.title, o.icon, NOOP)),
                  item('Report', 'FLAG', ytCommands.report(videoId)),
                ],
              },
            },
          },
        },
      },
    },
  };
}
