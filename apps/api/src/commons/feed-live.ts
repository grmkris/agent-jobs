import { FeedSink } from '@sidequest/commons'
import type { AsyncSql } from '@sidequest/indexer'
import type { Network } from '@sidequest/sdk'
import { Effect, Layer } from 'effect'
import { reportFeedFailure, writeFeed } from '../feed.ts'

export const feedLayer = (sql: AsyncSql, network: Network) =>
  Layer.succeed(FeedSink, {
    write: (events) =>
      // Commons events already carry Unix seconds (packages/commons/src/time.ts), as writeFeed expects.
      Effect.promise(() => writeFeed(sql, network, events, Math.floor(Date.now() / 1000)).catch(reportFeedFailure)),
  })
