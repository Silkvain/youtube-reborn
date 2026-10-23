import { ytCommands, ytMenuCommand } from '../src/content/yt-commands';

// Exact strings YouTube's own signed-in menus carried for these videos on the live site (Oct 2026).
const SEARCH_ID = 'gp7KUiJhpEE';
const HOME_ID = 'yPHLfg6Kw10';

type Json = Record<string, any>;

describe('YouTube menu commands', () => {
  it('Share: the same share entity YouTube builds', () => {
    expect((ytCommands.share(SEARCH_ID) as Json).shareEntityServiceEndpoint.serializedShareEntity).toBe('CgtncDdLVWlKaHBFRQ%3D%3D');
  });

  it('Save to playlist: the same sheet params YouTube uses', () => {
    expect((ytCommands.playlist(HOME_ID) as Json).showSheetCommand.panelLoadingStrategy.requestTemplate).toEqual({
      panelId: 'PAadd_to_playlist',
      params: '-gYNCgt5UEhMZmc2S3cxMA%3D%3D',
    });
  });

  it('Report: the same form params YouTube uses', () => {
    expect((ytCommands.report(HOME_ID) as Json).getReportFormEndpoint.params).toBe('Egt5UEhMZmc2S3cxMEABWABwAXgC2AEA6AEA');
  });

  it('Add to queue carries the watch command (without it YouTube ignores the request)', () => {
    const a = (ytCommands.queue(HOME_ID) as Json).signalServiceEndpoint.actions[0].addToPlaylistCommand;
    expect(a.listType).toBe('PLAYLIST_EDIT_LIST_TYPE_QUEUE');
    expect(a.videoCommand.watchEndpoint.videoId).toBe(HOME_ID);
  });

  it('Watch Later and Download: YouTube’s endpoints for this video', () => {
    expect(ytCommands.watchLater(HOME_ID)).toMatchObject({ playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: HOME_ID, action: 'ACTION_ADD_VIDEO' }] } });
    expect(ytCommands.download(HOME_ID)).toMatchObject({ offlineVideoEndpoint: { videoId: HOME_ID } });
  });

  it('the ⋮ sheet: YouTube’s items in YouTube’s order, ours before Report', () => {
    const items = (ytMenuCommand(HOME_ID, [{ title: 'Not interested in this video', icon: 'HIDE' }]) as Json).showSheetCommand.panelLoadingStrategy
      .inlineContent.sheetViewModel.content.listViewModel.listItems as Json[];
    const label = (i: Json) => i.listItemViewModel?.title.content ?? (i.downloadListItemViewModel ? 'Download' : '?');
    expect(items.map(label)).toEqual(['Add to queue', 'Save to Watch Later', 'Save to playlist', 'Download', 'Share', 'Not interested in this video', 'Report']);
    // Our item runs nothing on YouTube's side if it ever slips through.
    expect(items[5]!.listItemViewModel.rendererContext.commandContext.onTap.innertubeCommand).toEqual({ signalServiceEndpoint: { signal: 'CLIENT_SIGNAL', actions: [] } });
  });

  it('IDs with "-" and "_" encode correctly', () => {
    const entity = (ytCommands.share('J---aiyznGQ') as Json).shareEntityServiceEndpoint.serializedShareEntity as string;
    expect(atob(entity.replace(/%3D/g, '='))).toBe('\n\x0bJ---aiyznGQ');
  });
});
