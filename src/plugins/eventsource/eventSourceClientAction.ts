import * as io from '../../io';
import * as models from '../../models';
import * as utils from '../../utils';
import { EventSourceRequest, isEventSourceRequest } from './eventSourceRequest';
import EventSource from 'eventsource';

export class EventSourceClientAction {
  id = 'sse';

  async process(context: models.ProcessorContext): Promise<boolean> {
    const { request } = context;
    if (isEventSourceRequest(request)) {
      return await utils.triggerRequestResponseHooks(async () => {
        if (request.url) {
          utils.report(context, `request Server-Sent Events ${request.url}`);
          return await this.requestEventSource(request, context);
        }
        return false;
      }, context);
    }
    return false;
  }

  private async requestEventSource(
    request: EventSourceRequest,
    context: models.ProcessorContext
  ): Promise<models.HttpResponse> {
    const { httpRegion } = context;

    if (!request.url) {
      throw new Error('request url undefined');
    }
    const options: EventSource.EventSourceInitDict = {};
    if (httpRegion.metaData.noRejectUnauthorized) {
      options.rejectUnauthorized = false;
    }
    const headers = { ...request.headers };
    utils.deleteHeader(headers, 'event');
    options.headers = headers;

    const responseTemplate: Partial<models.HttpResponse> = {
      request,
    };
    const eventStream: { [key: string]: Array<unknown> } = {};
    const loadingPromises: Array<Promise<unknown>> = [];

    let disposeCancellation: models.Dispose | undefined;
    try {
      const client = new EventSource(request.url, options);
      if (context.progress) {
        disposeCancellation = context.progress?.register?.(() => {
          client.close();
        });
      }
      client.addEventListener('open', evt => {
        io.log.debug('SSE open', evt);
      });

      const events = utils.getHeaderArray(request.headers, 'event', ['data']);
      for (const eventType of events) {
        client.addEventListener(eventType, evt => {
          io.log.debug(`SSE ${eventType}`, evt);
          if (this.isMessageEvent(evt)) {
            if (!eventStream[evt.type]) {
              eventStream[evt.type] = [];
            }
            eventStream[evt.type].push(evt.data);
            if (!context.httpRegion.metaData.noStreamingLog) {
              if (context.logStream) {
                loadingPromises.push(
                  context.logStream(evt.type, {
                    ...responseTemplate,
                    protocol: 'SSE',
                    name: `SSE ${evt.type} ${evt.lastEventId} (${request.url})`,
                    statusCode: 0,
                    body: evt.data,
                    message: utils.toString(evt.data),
                    headers: {
                      type: evt.type,
                      cancelable: evt.cancelable,
                      composed: evt.composed,
                      origin: evt.origin,
                      lastEventId: evt.lastEventId,
                    },
                  })
                );
              }
            }
          }
        });
      }
      client.addEventListener('error', evt => {
        io.log.debug('SSE error', evt);
        eventStream.error = [evt];
      });
      const onStreaming = context.httpFile.hooks.onStreaming.merge(context.httpRegion.hooks.onStreaming);
      await onStreaming.trigger(context);
      await Promise.all(loadingPromises);
      client.close();
      const response = this.toMergedHttpResponse(eventStream, responseTemplate);
      return response;
    } finally {
      if (disposeCancellation) {
        disposeCancellation();
      }
    }
  }

  private isEventType(evt: unknown): evt is { type: string } {
    const data = evt as { type: string };
    return !!data?.type;
  }

  private toMergedHttpResponse(
    data: Record<string, Array<unknown>>,
    responseTemplate: Partial<models.HttpResponse>
  ): models.HttpResponse {
    const response = this.toHttpResponse(data, responseTemplate);
    if (data.error) {
      response.statusCode = -1;
    }
    return response;
  }

  private toHttpResponse(
    data: Record<string, Array<unknown>>,
    responseTemplate: Partial<models.HttpResponse>
  ): models.HttpResponse {
    const body = JSON.stringify(data, null, 2);
    const rawBody: Buffer = Buffer.from(body);
    const response: models.HttpResponse = {
      headers: {},
      statusCode: 0,
      ...responseTemplate,
      protocol: 'SSE',
      body,
      prettyPrintBody: body,
      parsedBody: data,
      rawBody,
      contentType: {
        mimeType: 'application/json',
        charset: 'UTF-8',
        contentType: 'application/json; charset=utf-8',
      },
    };
    if (this.isEventType(data) && data.type === 'error') {
      response.statusCode = -1;
    }
    return response;
  }

  private isMessageEvent(obj: unknown): obj is EventSourceMessageEvent {
    const evt = obj as EventSourceMessageEvent;
    return !!evt.type && utils.isString(evt.type) && !!evt.data;
  }
}

interface EventSourceMessageEvent {
  type: string;
  data: unknown;
}
