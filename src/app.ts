/* tslint:disable:no-console */
import express from 'express';
import bodyParser from 'body-parser';
import HTTP from 'http';
import HTTPS from 'https';
import _ from 'lodash';
import { socket } from 'zeromq';
import moment from 'moment';
import fs from 'fs';
import request from 'request';
import ErrorHandler from './errors/error-handler';

export const enum MessageTypes {
  STOP,
  START,
  ERROR,
  LOG,
}

export const enum LogTypes {
  SERVER,
  REQUEST,
  RESPONSE,
  ERROR,
}

interface ILog {
  readonly body?: any;
  readonly date?: string;
  readonly matched?: boolean;
  readonly method?: string;
  readonly path?: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly port?: number;
  readonly statusCode?: number;
  readonly query?: any;
  readonly type: LogTypes;
  readonly message?: string;
  readonly headers?: any;
  readonly url?: string;
}

class App {
  // @ts-ignore
  private port: number;
  // @ts-ignore
  private sslPort: number;
  // @ts-ignore
  private express: express.Express;
  private config: IConfig = {
    entities: { endpoints: [], projects: [] },
    result: { httpPort: 3000, httpsPort: 3001 },
  };
  private httpServer?: HTTP.Server;
  private sslServer?: HTTPS.Server;
  private socket: any;
  private socketLogs: any;
  private errorHandler: ErrorHandler;
  private endpointsParams = new Map<string, any>();
  private endpointsBody = new Map<string, any>();
  private endpointsResponse = new Map<string, any>();

  constructor(errorHandler: ErrorHandler) {
    this.setupServer(this.config);

    const socketsDir = '/tmp/apimocker_server';
    if (!fs.existsSync(socketsDir)) fs.mkdirSync(socketsDir);

    this.errorHandler = errorHandler;

    this.socket = socket('pull');
    this.socket.connect(`ipc://${socketsDir}/commands.ipc`);
    this.socket.on('message', this.handleUIMessage);

    this.socketLogs = socket('push');
    this.socketLogs.bindSync(`ipc://${socketsDir}/logs.ipc`);
  }

  setupServer(config: IConfig) {
    this.config = config;

    const { httpPort, httpsPort } = config.result;
    this.port = httpPort || 3000;
    this.sslPort = httpsPort || 3001;

    this.express = express();
    this.express.use(bodyParser.raw({ type: '*/*' }));
    this.mountRoutes();
  }

  isListening = (): boolean => {
    return this.httpServer ? this.httpServer.listening : false;
  };

  stop = (callback: ((error: Error) => void)) => {
    const afterStop = (error: Error) => {
      if (!error) {
        const logObject: ILog = {
          type: LogTypes.SERVER,
          message: 'STOP',
          date: moment().format('YYYY/MM/DD HH:mm:ss'),
          matched: true,
        };
        this.socketLogs.send(JSON.stringify(logObject));
      }
      callback(error);
    };

    if (this.httpServer) this.httpServer.close(afterStop);
    if (this.sslServer) this.sslServer.close(afterStop);
  };

  start = (callback: ((error: Error) => void)) => {
    const afterStart = (error: Error) => {
      if (!error) {
        const logObject: ILog = {
          type: LogTypes.SERVER,
          message: 'START',
          date: moment().format('YYYY/MM/DD HH:mm:ss'),
          matched: true,
        };
        this.socketLogs.send(JSON.stringify(logObject));
      }
      callback(error);
    };

    this.httpServer = HTTP.createServer(this.express);
    this.httpServer.listen(this.port, afterStart).on('error', (error: any) => {
      this.errorHandler.checkErrorAndStopProcess(error);
    });

    if (fs.existsSync('./localhost.key') && fs.existsSync('./localhost.crt')) {
      const sslOptions = {
        key: fs.readFileSync('./localhost.key'),
        cert: fs.readFileSync('./localhost.crt'),
      };

      // TODO: We should get proper Android support before we launch SSL support
      // this.sslServer = HTTPS.createServer(sslOptions, this.express).listen(this.sslPort, afterStart);
    }
  };

  private handleUIMessage = (message: Uint8Array) => {
    const messageCode = Number(message.toString());

    switch (messageCode) {
      case MessageTypes.STOP:
        return this.stop(this.handleError);
      case MessageTypes.START:
        return this.start(this.handleError);
      default:
    }
  };

  private handleError = (error: Error) => {
    if (!error) return;
    const logObject: ILog = {
      type: LogTypes.SERVER,
      message: `ERROR ${error}`,
      matched: true,
      date: moment().format('YYYY/MM/DD HH:mm:ss'),
    };
    this.socketLogs.send(JSON.stringify(logObject));
  };

  private mountRoutes(): void {
    const { endpoints, projects } = this.config.entities;
    _.forEach(endpoints, (endpoint: IEndpoint) => {
      const project = projects[endpoint.projectId];
      this.register(endpoint, project.name);
      const endpointPath = '/' + project.name + endpoint.path;

      if (endpoint.request.params) {
        this.endpointsResponse.set(endpoint.method + endpointPath + endpoint.request.params, endpoint.response);
      } else if (endpoint.request.body && !_.isEqual(endpoint.request.body, {})) {
        this.endpointsResponse.set(
          endpoint.method + endpointPath + JSON.stringify(endpoint.request.body),
          endpoint.response
        );
      } else {
        this.endpointsResponse.set(endpoint.method + endpointPath, endpoint.response);
      }

      this.parseParamsEndpoint(endpoint, endpointPath);
      this.parseBodyEndpoint(endpoint, endpointPath);
    });
    this.addMissedRouteHandler();
  }

  private parseParamsEndpoint(endpoint: IEndpoint, endpointPath: string) {
    const paramsValues = this.endpointsParams.get(endpointPath);

    if (paramsValues && paramsValues.length > 0) {
      const params = paramsValues;
      params.push(endpoint.request.params);
      this.endpointsParams.set(endpointPath, params);
    } else {
      const params = [];
      params.push(endpoint.request.params);
      this.endpointsParams.set(endpointPath, params);
    }
  }

  private parseBodyEndpoint(endpoint: IEndpoint, endpointPath: string) {
    const bodyValues = this.endpointsBody.get(endpointPath);

    if (bodyValues && bodyValues.length > 0) {
      const bodyArray = bodyValues;
      bodyArray.push(endpoint.request.body);
      this.endpointsBody.set(endpointPath, bodyArray);
    } else {
      const bodyArray = [];
      bodyArray.push(endpoint.request.body);
      this.endpointsBody.set(endpointPath, bodyArray);
    }
  }

  private getAppropriateListenerFunction(method: string): express.IRouterMatcher<express.Express> {
    if (method === 'delete') return this.express.delete.bind(this.express);
    if (method === 'get') return this.express.get.bind(this.express);
    if (method === 'patch') return this.express.patch.bind(this.express);
    if (method === 'post') return this.express.post.bind(this.express);
    if (method === 'put') return this.express.put.bind(this.express);

    throw new Error('[getAppropriateListenerFunction] Unexpected API method to listen for');
  }

  private sendLog(req: express.Request, matched: boolean, type: LogTypes, statusCode: number, respBody?: object): void {
    const log = {
      method: req.method,
      path: req.path,
      body: req.body,
      matched,
      protocol: req.protocol,
      host: req.hostname,
      date: moment().format('YYYY/MM/DD HH:mm:ss'),
      port: parseInt(this.port.toString(), 10),
      query: req.query,
      type,
      statusCode,
      response: respBody,
    };
    this.socketLogs.send(JSON.stringify(log));
  }

  private register(endpoint: IEndpoint, scope = ''): void {
    const path = '/' + scope + endpoint.path;
    const method = endpoint.method.toLowerCase();
    const statusCode = endpoint.statusCode || 200;
    const timeout = endpoint.timeout || 0;

    const httpMethodListenerFunction = this.getAppropriateListenerFunction(method);
    httpMethodListenerFunction(path, (req: express.Request, res: any) => {
      const response = res.status(statusCode);

      if (req.query && !_.isEmpty(req.query)) {
        const paramExists = this.paramsExists(this.endpointsParams.get(req.path), req);

        if (paramExists) {
          this.sendResponse(
            timeout,
            response,
            this.endpointsResponse.get(req.method + req.path + this.parseQueryToString(req.query)),
            req,
            statusCode
          );
        } else {
          this.sendResponse(timeout, response, 'Not found', req, 404);
        }
      } else if (req.body && !_.isEmpty(req.body)) {
        const requestBody = req.body.toString('utf8');
        const bodyExists = this.bodyExists(this.endpointsBody.get(req.path), requestBody);

        if (bodyExists) {
          if (this.isJsonString(requestBody)) {
            this.sendResponse(
              timeout,
              response,
              this.endpointsResponse.get(req.method + req.path + JSON.stringify(JSON.parse(requestBody))),
              req,
              statusCode
            );
          } else {
            this.sendResponse(
              timeout,
              response,
              this.endpointsResponse.get(req.method + req.path + requestBody),
              req,
              statusCode
            );
          }
        } else {
          this.sendResponse(timeout, response, 'Not found', req, 404);
        }
      } else {
        this.sendResponse(timeout, response, this.endpointsResponse.get(req.method + req.path), req, statusCode);
      }
    });
  }

  private isJsonString(str: any) {
    try {
      JSON.parse(str);
    } catch (e) {
      return false;
    }
    return true;
  }

  private bodyExists(bodyForEndpoint: any, requestBody: any) {
    let bodyExists = false;
    bodyForEndpoint.forEach((body: JSON | string) => {
      if (this.isJsonString(requestBody)) {
        if (_.isEqual(requestBody, {}) && _.isEqual(body, requestBody)) {
          bodyExists = true;
        } else if (_.isEqual(body, JSON.parse(requestBody))) {
          bodyExists = true;
        }
      } else {
        if (_.isEqual(body, requestBody)) {
          bodyExists = true;
        }
      }
    });

    return bodyExists;
  }

  private paramsExists(paramsForEndpoint: any, req: express.Request) {
    let paramExists = false;
    paramsForEndpoint.forEach((param: string) => {
      if (_.isEqual(this.parseQuery(param), req.query)) {
        paramExists = true;
      }
    });

    return paramExists;
  }

  private sendResponse(
    timeout: number,
    response: any,
    endpointResponse: any,
    req: express.Request,
    statusCode: number
  ) {
    if (timeout > 0) {
      setTimeout(() => response.status(statusCode).send(endpointResponse), timeout);
    } else {
      response.status(statusCode).send(endpointResponse);
    }

    this.sendLog(req, true, LogTypes.REQUEST, statusCode);
  }

  private parseQuery(queryString: string) {
    if (queryString.length > 0) {
      const query: any = {};
      const pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
      for (const item of pairs) {
        const pair: any = item.split('=');
        query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '');
      }
      return query;
    } else {
      return {};
    }
  }

  private parseQueryToString(obj: any) {
    return (
      '?' +
      Object.keys(obj)
        .reduce((a: any, k: string) => {
          a.push(k + '=' + encodeURIComponent(obj[k]));
          return a;
        }, [])
        .join('&')
    );
  }

  private addMissedRouteHandler() {
    this.express.use('/', (req: express.Request, res: any, next: any) => {
      const projectName = req.originalUrl.split('/')[1];
      const project = _.find(this.config.entities.projects, proj => proj.name === projectName);

      if (project && project.fallbackUrlPrefix && project.fallbackUrlPrefix.domain) {
        const response = this.forwardRequest(req, res);
      } else {
        this.sendLog(req, false, LogTypes.RESPONSE, 404);
        res.status(404).send('Not found');
      }
    });
  }

  private getForwardingOptions(req: express.Request) {
    const [_unused, projectName, ...localPath] = req.originalUrl.split('/');
    const project = _.find(this.config.entities.projects, proj => proj.name === projectName);
    const { domain, path, port } = project.fallbackUrlPrefix;
    const portInfo = port ? `:${port}` : '';

    const url = `http://${domain}${portInfo}${path}/${localPath.join('/')}`;

    return {
      headers: { ...req.headers, host: domain },
      method: req.method,
      body: req.method === 'GET' ? null : req.body,
      url,
    };
  }

  private forwardRequest(req: express.Request, responseStream: express.Response) {
    const options = this.getForwardingOptions(req);

    request(options, (error, response, body) => {
      if (error) {
        this.sendLog(req, false, LogTypes.ERROR, 0, error.toString());
      } else {
        this.sendLog(req, true, LogTypes.RESPONSE, response && response.statusCode ? response.statusCode : 418, body);
      }
    }).pipe(responseStream);
  }
}

export default App;
