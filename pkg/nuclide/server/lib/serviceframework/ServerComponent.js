'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import {Observable} from 'rx';
import {getDefinitions} from '../../../service-parser';
import type NuclideServer from '../NuclideServer';
import TypeRegistry from '../../../service-parser/lib/TypeRegistry';
import {builtinLocation, voidType} from '../../../service-parser/lib/builtin-types';
import type {
  VoidType,
  FunctionType,
  PromiseType,
  ObservableType,
  Definition,
  InterfaceDefinition,
  Type,
} from '../../../service-parser/lib/types';
import invariant from 'assert';
import type {ConfigEntry} from './index';

import type {RequestMessage, ErrorResponseMessage, PromiseResponseMessage,
  ObservableResponseMessage} from './types';
import type {SocketClient} from '../NuclideServer';

const logger = require('../../../logging').getLogger();

type FunctionImplementation = {localImplementation: Function, type: FunctionType};

type RemoteObject = {
  _interface: string,
  _remoteId: ?number,
  dispose: () => mixed,
};

export default class ServerComponent {
  _typeRegistry: TypeRegistry;

  /**
   * Store a mapping from function name to a structure holding both the local implementation and
   * the type definition of the function.
   */
  _functionsByName: Map<string, FunctionImplementation>;

  /**
   * Store a mapping from a class name to a struct containing it's local constructor and it's
   * interface definition.
   */
  _classesByName: Map<string, {localImplementation: any, definition: InterfaceDefinition}>;

  _objectRegistry: Map<number, RemoteObject>;
  _nextObjectId: number;

  _subscriptions: Map<number, IDisposable>;

  _server: NuclideServer;

  constructor(server: NuclideServer, services: Array<ConfigEntry>) {
    this._server = server;

    this._typeRegistry = new TypeRegistry();
    this._functionsByName = new Map();
    this._classesByName = new Map();

    this._nextObjectId = 1;
    this._objectRegistry = new Map();

    this._subscriptions = new Map();

    // NuclideUri type requires no transformations (it is done on the client side).
    this._typeRegistry.registerType('NuclideUri', uri => uri, remotePath => remotePath);

    this.addServices(services);
  }

  addServices(services: Array<ConfigEntry>): void {
    services.forEach(this.addService, this);
  }

  addService(service: ConfigEntry): void {
    logger.debug(`Registering 3.0 service ${service.name}...`);
    try {
      const defs = getDefinitions(service.definition);
      // $FlowIssue - the parameter passed to require must be a literal string.
      const localImpl = require(service.implementation);

      // Register type aliases.
      defs.forEach((definition: Definition) => {
        const name = definition.name;
        switch (definition.kind) {
          case 'alias':
            logger.debug(`Registering type alias ${name}...`);
            if (definition.definition != null) {
              this._typeRegistry.registerAlias(name, (definition.definition: Type));
            }
            break;
          case 'function':
            // Register module-level functions.
            this._registerFunction(`${service.name}/${name}`, localImpl[name], definition.type);
            break;
          case 'interface':
            // Register interfaces.
            logger.debug(`Registering interface ${name}...`);
            this._classesByName.set(name,  {
              localImplementation: localImpl[name],
              definition,
            });

            this._typeRegistry.registerType(name, async object => {
              // If the object has already been assigned an id, return that id.
              if (object._remoteId) {
                return object._remoteId;
              }

              // Put the object in the registry.
              object._interface = name;
              const objectId = this._nextObjectId;
              this._objectRegistry.set(objectId, object);
              object._remoteId = objectId;
              this._nextObjectId++;

              return objectId;
            }, async objectId => this._objectRegistry.get(objectId));

            // Register all of the static methods as remote functions.
            definition.staticMethods.forEach((funcType, funcName) => {
              this._registerFunction(`${name}/${funcName}`, localImpl[name][funcName], funcType);
            });
            break;
        }
      });

    } catch (e) {
      logger.error(`Failed to load service ${service.name}. Stack Trace:\n${e.stack}`);
      throw e;
    }
  }

  _registerFunction(name: string, localImpl: Function, type: FunctionType): void {
    logger.debug(`Registering function ${name}...`);
    if (this._functionsByName.has(name)) {
      throw new Error(`Duplicate RPC function: ${name}`);
    }
    this._functionsByName.set(name,  {
      localImplementation: localImpl,
      type,
    });
  }

  async handleMessage(client: SocketClient, message: RequestMessage): Promise<void> {
    const requestId = message.requestId;

    let returnVal: ?(Promise | Observable) = null;
    let returnType: PromiseType | ObservableType | VoidType = voidType;
    let callError;
    let hadError = false;

    try {
      switch (message.type) {
        case 'FunctionCall':
          // Transform arguments and call function.
          const {
            localImplementation: fcLocalImplementation,
            type: fcType,
          } = this._getFunctionImplemention(message.function);
          const fcTransfomedArgs = await Promise.all(
            message.args.map((arg, i) => this._typeRegistry.unmarshal(arg, fcType.argumentTypes[i]))
          );

          // Invoke function and return the results.
          invariant(fcType.returnType.kind === 'void' ||
            fcType.returnType.kind === 'promise' ||
            fcType.returnType.kind === 'observable');
          returnType = (fcType.returnType: PromiseType | ObservableType | VoidType);
          returnVal = fcLocalImplementation.apply(this, fcTransfomedArgs);
          break;
        case 'MethodCall':
          // Get the object.
          const mcObject = this._objectRegistry.get(message.objectId);
          invariant(mcObject != null);

          // Get the method FunctionType description.
          const className = this._classesByName.get(mcObject._interface);
          invariant(className != null);
          const mcType = className.definition.instanceMethods.get(message.method);
          invariant(mcType != null);

          // Unmarshal arguments.
          const mcTransfomedArgs = await Promise.all(
            message.args.map((arg, i) => this._typeRegistry.unmarshal(arg, mcType.argumentTypes[i]))
          );

          // Invoke message.
          invariant(mcType.returnType.kind === 'void' ||
            mcType.returnType.kind === 'promise' ||
            mcType.returnType.kind === 'observable');
          returnType = (mcType.returnType: PromiseType | ObservableType | VoidType);
          returnVal = mcObject[message.method].apply(mcObject, mcTransfomedArgs);
          break;
        case 'NewObject':
          const classDefinition = this._classesByName.get(message.interface);
          invariant(classDefinition != null);
          const {
            localImplementation: noLocalImplementation,
            definition: noDefinition,
          } = classDefinition;

          // Transform arguments.
          const noTransfomedArgs = await Promise.all(message.args.map((arg, i) =>
            this._typeRegistry.unmarshal(arg, noDefinition.constructorArgs[i])));

          // Create a new object and put it in the registry.
          const noObject = construct(noLocalImplementation, noTransfomedArgs);

          // Return the object, which will automatically be converted to an id through the
          // marshalling system.
          returnType = {
            kind: 'promise',
            type: {
              kind: 'named',
              name: message.interface,
              location: builtinLocation,
            },
            location: builtinLocation,
          };
          returnVal = Promise.resolve(noObject);
          break;
        case 'DisposeObject':
          // Get the object.
          const doObject = this._objectRegistry.get(message.objectId);
          invariant(doObject != null);

          // Remove the object from the registry, and scrub it's id.
          doObject._remoteId = undefined;
          this._objectRegistry.delete(message.objectId);

          // Call the object's local dispose function.
          returnType = {
            kind: 'promise',
            type: voidType,
            location: builtinLocation,
          };
          await doObject.dispose();

          // Return a void Promise
          returnVal = Promise.resolve();
          break;
        case 'DisposeObservable':
          // Dispose an in-progress observable, before it has naturally completed.
          const subscription = this._subscriptions.get(requestId);
          if (subscription != null) {
            subscription.dispose();
            this._subscriptions.delete(requestId);
          }
          break;
        default:
          throw new Error(`Unkown message type ${message.type}`);
      }
    } catch (e) {
      logger.error(e != null ? e.message : e);
      callError = e;
      hadError = true;
    }

    switch (returnType.kind) {
      case 'void':
        break; // No need to send anything back to the user.
      case 'promise':
        // If there was an error executing the command, we send that back as a rejected promise.
        if (hadError) {
          returnVal = Promise.reject(callError);
        }

        // Ensure that the return value is a promise.
        if (!isThenable(returnVal)) {
          returnVal = Promise.reject(
            new Error('Expected a Promise, but the function returned something else.'));
        }

        // Marshal the result, to send over the network.
        invariant(returnVal != null);
        // $FlowIssue
        returnVal = returnVal.then(value => this._typeRegistry.marshal(value, returnType.type));

        // Send the result of the promise across the socket.
        returnVal.then(result => {
          const resultMessage: PromiseResponseMessage = {
            channel: 'service_framework3_rpc',
            type: 'PromiseMessage',
            requestId,
            result,
            hadError: false,
          };
          this._server._sendSocketMessage(client, resultMessage);
        }, error => {
          const errorMessage: ErrorResponseMessage = {
            channel: 'service_framework3_rpc',
            type: 'ErrorMessage',
            requestId,
            hadError: true,
            error: formatError(error),
          };
          this._server._sendSocketMessage(client, errorMessage);
        });
        break;
      case 'observable':
        // If there was an error executing the command, we send that back as an error Observable.
        if (hadError) {
          returnVal = Observable.throw(callError);
        }

        // Ensure that the return value is an observable.
        if (!isObservable(returnVal)) {
          returnVal = Observable.throw(new Error(
            'Expected an Observable, but the function returned something else.'));
        }
        let returnObservable: Observable = (returnVal : any);

        // Marshal the result, to send over the network.
        returnObservable = returnObservable.concatMap(
            // $FlowIssue
            value => this._typeRegistry.marshal(value, returnType.type));

        // Send the next, error, and completion events of the observable across the socket.
        const subscription = returnObservable.subscribe(data => {
          const eventMessage: ObservableResponseMessage = {
            channel: 'service_framework3_rpc',
            type: 'ObservableMessage',
            requestId,
            hadError: false,
            result: {
              type: 'next',
              data: data,
            },
          };
          this._server._sendSocketMessage(client, eventMessage);
        }, error => {
          const errorMessage: ErrorResponseMessage = {
            channel: 'service_framework3_rpc',
            type: 'ErrorMessage',
            requestId,
            hadError: true,
            error: formatError(error),
          };
          this._server._sendSocketMessage(client, errorMessage);
          this._subscriptions.delete(requestId);
        }, completed => {
          const eventMessage: ObservableResponseMessage = {
            channel: 'service_framework3_rpc',
            type: 'ObservableMessage',
            requestId,
            hadError: false,
            result: { type: 'completed' },
          };
          this._server._sendSocketMessage(client, eventMessage);
          this._subscriptions.delete(requestId);
        });
        this._subscriptions.set(requestId, subscription);
        break;
      default:
        throw new Error(`Unkown return type ${returnType.kind}.`);
    }
  }

  _getFunctionImplemention(name: string): FunctionImplementation {
    const result = this._functionsByName.get(name);
    invariant(result);
    return result;
  }
}

/**
 * A helper function that let's us 'apply' an array of arguments to a constructor.
 * It works by creating a new constructor that has the same prototype as the original
 * constructor, and simply applies the original constructor directly to 'this'.
 * @returns An instance of classObject.
 */
function construct(classObject, args) {
  function F() {
    return classObject.apply(this, args);
  }
  F.prototype = classObject.prototype;
  return new F();
}

/**
 * A helper function that checks if an object is thenable (Promise-like).
 */
function isThenable(object: any): boolean {
  return Boolean(object && object.then);
}

/**
 * A helper function that checks if an object is an Observable.
 */
function isObservable(object: any): boolean {
  return Boolean(object && object.concatMap && object.subscribe);
}

/**
 * Format the error before sending over the web socket.
 * TODO: This should be a custom marshaller registered in the TypeRegistry
 */
function formatError(error): ?(Object | string) {
  if (error instanceof Error) {
    return {
      message: error.message,
      code: error.code,
      stack: error.stack,
    };
  } else if (typeof error === 'string') {
    return error.toString();
  } else if (error === undefined) {
    return undefined;
  } else {
    return `Unknown Error: ${error.toString()}`;
  }
}
