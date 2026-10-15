import { runPipeline } from '../src/pipeline';
import { playlists } from '../src/hls';
import { getWatch, info, getStream, getComments } from '../src/api';
import { layoutComments } from '../src/comments';
Object.assign(window, { runPipeline, playlists, getWatch, info, getStream, getComments, layoutComments });
