'use strict';

const { Client } = require('ssh2');
const fs = require('fs');
const concat = require('concat-stream');
const promiseRetry = require('promise-retry');
const { join, parse } = require('path');
const {
  fmtError,
  addTempListeners,
  removeTempListeners,
  haveConnection,
  normalizeRemotePath,
  localExists,
  haveLocalAccess,
  haveLocalCreate,
  sleep,
} = require('./utils');
const { errorCode } = require('./constants');

class SftpClient {
  constructor(clientName) {
    this.client = new Client();
    this.sftp = undefined;
    this.clientName = clientName ? clientName : 'sftp';
    this.endCalled = false;
    this.errorHandled = false;
    this.closeHandled = false;
    this.endHandled = false;
    this.remotePathSep = '/';
    this.remotePlatform = 'unix';
    this.debug = undefined;

    this.client.on('close', () => {
      if (this.endCalled || this.closeHandled) {
        // we are processing an expected end event or close event handled elsewhere
        this.debugMsg('Global: Ignoring handled close event');
      } else {
        this.debugMsg('Global: Handling unexpected close event');
        this.sftp = undefined;
      }
    });

    this.client.on('end', () => {
      if (this.endCalled || this.endHandled) {
        // end event expected or handled elsewhere
        this.debugMsg('Global: Ignoring hanlded end event');
      } else {
        this.debugMsg('Global: Handling unexpected end event');
        this.sftp = undefined;
      }
    });

    this.client.on('error', (err) => {
      if (this.endCalled || this.errorHandled) {
        // error event expected or handled elsewhere
        this.debugMsg(`Global: Ignoring handled error: ${err.message}`);
      } else {
        this.debugMsg(`Global; Handling unexpected error; ${err.message}`);
        this.sftp = undefined;
        console.log(
          `ssh2-sftp-client: Unexpected error: ${err.message}. Error code: ${err.code}`
        );
      }
    });
  }

  debugMsg(msg, obj) {
    if (this.debug) {
      if (obj) {
        this.debug(
          `CLIENT[${this.clientName}]: ${msg} ${JSON.stringify(obj, null, ' ')}`
        );
      } else {
        this.debug(`CLIENT[${this.clientName}]: ${msg}`);
      }
    }
  }

  /**
   * Add a listner to the client object. This is rarely necessary and can be
   * the source of errors. It is the client's responsibility to remove the
   * listeners when no longer required. Failure to do so can result in memory
   * leaks.
   *
   * @param {string} eventType - one of the supported event types
   * @param {function} callback - function called when event triggers
   */
  on(eventType, callback) {
    this.debugMsg(`Adding listener to ${eventType} event`);
    this.client.prependListener(eventType, callback);
  }

  removeListener(eventType, callback) {
    this.debugMsg(`Removing listener from ${eventType} event`);
    this.client.removeListener(eventType, callback);
  }

  _resetEventFlags() {
    this.closeHandled = false;
    this.endHandled = false;
    this.errorHandled = false;
  }

  /**
   * @async
   *
   * Create a new SFTP connection to a remote SFTP server
   *
   * @param {Object} config - an SFTP configuration object
   *
   * @return {Promise<Object>} which will resolve to an sftp client object
   *
   */
  getConnection(config) {
    let doReady, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'getConnection', reject);
      this.debugMsg('getConnection: created promise');
      doReady = () => {
        this.debugMsg(
          'getConnection ready listener: got connection - promise resolved'
        );
        resolve(true);
      };
      this.on('ready', doReady);
      this.client.connect(config);
    }).finally(async () => {
      this.debugMsg('getConnection: finally clause fired');
      await sleep(500);
      this.removeListener('ready', doReady);
      removeTempListeners(this, listeners, 'getConnection');
      this._resetEventFlags();
    });
  }

  getSftpChannel() {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'getSftpChannel', reject);
      this.debugMsg('getSftpChannel: created promise');
      this.client.sftp((err, sftp) => {
        if (err) {
          this.debugMsg(`getSftpChannel: SFTP Channel Error: ${err.message}`);
          this.client.end();
          reject(fmtError(err, 'getSftpChannel', err.code));
        } else {
          this.debugMsg('getSftpChannel: SFTP channel established');
          this.sftp = sftp;
          resolve(sftp);
        }
      });
    }).finally(() => {
      this.debugMsg('getSftpChannel: finally clause fired');
      removeTempListeners(this, listeners, 'getSftpChannel');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Create a new SFTP connection to a remote SFTP server.
   * The connection options are the same as those offered
   * by the underlying SSH2 module.
   *
   * @param {Object} config - an SFTP configuration object
   *
   * @return {Promise<Object>} which will resolve to an sftp client object
   *
   */
  async connect(config) {
    try {
      if (config.debug) {
        this.debug = config.debug;
        this.debugMsg('connect: Debugging turned on');
      }
      if (this.sftp) {
        this.debugMsg('connect: Already connected - reject');
        throw fmtError(
          'An existing SFTP connection is already defined',
          'connect',
          errorCode.connect
        );
      }
      await promiseRetry(
        (retry, attempt) => {
          this.debugMsg(`connect: Connect attempt ${attempt}`);
          return this.getConnection(config).catch((err) => {
            this.debugMsg(
              `getConnection retry catch: ${err.message} Code: ${err.code}`
            );
            switch (err.code) {
              case 'ENOTFOUND':
              case 'ECONNREFUSED':
              case 'ERR_SOCKET_BAD_PORT':
                throw err;
              default:
                retry(err);
            }
          });
        },
        {
          retries: config.retries || 1,
          factor: config.retry_factor || 2,
          minTimeout: config.retry_minTimeout || 1000,
        }
      );
      return this.getSftpChannel();
    } catch (err) {
      this.debugMsg(`connect: Error ${err.message}`);
      throw fmtError(err, 'connect');
    }
  }

  /**
   * @async
   *
   * Returns the real absolute path on the remote server. Is able to handle
   * both '.' and '..' in path names, but not '~'. If the path is relative
   * then the current working directory is prepended to create an absolute path.
   * Returns undefined if the path does not exists.
   *
   * @param {String} remotePath - remote path, may be relative
   * @returns {Promise<String>} - remote absolute path or ''
   */
  _realPath(rPath) {
    return new Promise((resolve, reject) => {
      this.debugMsg(`_realPath -> ${rPath}`);
      this.sftp.realpath(rPath, (err, absPath) => {
        if (err) {
          this.debugMsg(`realPath Error: ${err.message} Code: ${err.code}`);
          if (err.code === 2) {
            resolve('');
          } else {
            reject(fmtError(`${err.message} ${rPath}`, 'realPath', err.code));
          }
        }
        this.debugMsg(`_realPath <- ${absPath}`);
        resolve(absPath);
      });
    });
  }

  async realPath(remotePath) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'realPath');
      haveConnection(this, 'realPath');
      return await this._realPath(remotePath);
    } catch (e) {
      throw e.custom
        ? e
        : fmtError(`${e.message} ${remotePath}`, 'realPath', e.code);
    } finally {
      removeTempListeners(this, listeners, 'realPath');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Return the current workding directory path
   *
   * @returns {Promise<String>} - current remote working directory
   */
  cwd() {
    return this.realPath('.');
  }

  /**
   * Retrieves attributes for path
   *
   * @param {String} remotePath - a string containing the path to a file
   * @return {Promise<Object>} stats - attributes info
   */
  _stat(aPath) {
    return new Promise((resolve, reject) => {
      this.debugMsg(`_stat: ${aPath}`);
      this.sftp.stat(aPath, (err, stats) => {
        if (err) {
          this.debugMsg(`_stat: Error ${err.message} code: ${err.code}`);
          if (err.code === 2 || err.code === 4) {
            reject(
              fmtError(`No such file: ${aPath}`, '_stat', errorCode.notexist)
            );
          } else {
            reject(fmtError(`${err.message} ${aPath}`, '_stat', err.code));
          }
        } else {
          const result = {
            mode: stats.mode,
            uid: stats.uid,
            gid: stats.gid,
            size: stats.size,
            accessTime: stats.atime * 1000,
            modifyTime: stats.mtime * 1000,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            isBlockDevice: stats.isBlockDevice(),
            isCharacterDevice: stats.isCharacterDevice(),
            isSymbolicLink: stats.isSymbolicLink(),
            isFIFO: stats.isFIFO(),
            isSocket: stats.isSocket(),
          };
          this.debugMsg('_stat: stats <- ', result);
          resolve(result);
        }
      });
    });
  }

  async stat(remotePath) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'stat');
      haveConnection(this, 'stat');
      const absPath = await normalizeRemotePath(this, remotePath);
      return await this._stat(absPath);
    } catch (err) {
      throw err.custom ? err : fmtError(err, 'stat', err.code);
    } finally {
      removeTempListeners(this, listeners, 'stat');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Tests to see if an object exists. If it does, return the type of that object
   * (in the format returned by list). If it does not exist, return false.
   *
   * @param {string} remotePath - path to the object on the sftp server.
   *
   * @return {Promise<Boolean|String>} returns false if object does not exist. Returns type of
   *                   object if it does
   */
  async _exists(rPath) {
    try {
      const absPath = await normalizeRemotePath(this, rPath);
      this.debugMsg(`exists: ${rPath} -> ${absPath}`);
      const info = await this._stat(absPath);
      this.debugMsg('exists: <- ', info);
      if (info.isDirectory) {
        this.debugMsg(`exists: ${rPath} = d`);
        return 'd';
      }
      if (info.isSymbolicLink) {
        this.debugMsg(`exists: ${rPath} = l`);
        return 'l';
      }
      if (info.isFile) {
        this.debugMsg(`exists: ${rPath} = -`);
        return '-';
      }
      this.debugMsg(`exists: ${rPath} = false`);
      return false;
    } catch (err) {
      if (err.code === errorCode.notexist) {
        this.debugMsg(`exists: ${rPath} = false errorCode = ${err.code}`);
        return false;
      }
      this.debugMsg(`exists: throw error ${err.message} ${err.code}`);
      throw err.custom ? err : fmtError(err.message, 'exists', err.code);
    }
  }

  async exists(remotePath) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'exists');
      haveConnection(this, 'exists');
      if (remotePath === '.') {
        return 'd';
      }
      return await this._exists(remotePath);
    } catch (err) {
      throw err.custom ? err : fmtError(err, 'exists', err.code);
    } finally {
      removeTempListeners(this, listeners, 'exists');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * List contents of a remote directory. If a pattern is provided,
   * filter the results to only include files with names that match
   * the supplied pattern. Return value is an array of file entry
   * objects that include properties for type, name, size, modifiyTime,
   * accessTime, rights {user, group other}, owner and group.
   *
   * @param {String} remotePath - path to remote directory
   * @param {function} filter - a filter function used to select return entries
   * @returns {Promise<Array>} array of file description objects
   */
  _list(remotePath, filter) {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(remotePath, (err, fileList) => {
        if (err) {
          this.debugMsg(`list: Error ${err.message} code: ${err.code}`);
          reject(fmtError(`${err.message} ${remotePath}`, 'list', err.code));
        } else {
          const reg = /-/gi;
          const newList = fileList.map((item) => {
            return {
              type: item.longname.slice(0, 1),
              name: item.filename,
              size: item.attrs.size,
              modifyTime: item.attrs.mtime * 1000,
              accessTime: item.attrs.atime * 1000,
              rights: {
                user: item.longname.slice(1, 4).replace(reg, ''),
                group: item.longname.slice(4, 7).replace(reg, ''),
                other: item.longname.slice(7, 10).replace(reg, ''),
              },
              owner: item.attrs.uid,
              group: item.attrs.gid,
              longname: item.longname,
            };
          });
          if (filter) {
            resolve(newList.filter((item) => filter(item)));
          } else {
            resolve(newList);
          }
        }
      });
    });
  }

  async list(remotePath, filter) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'list');
      haveConnection(this, 'list');
      return await this._list(remotePath, filter);
    } catch (e) {
      throw e.custom
        ? e
        : fmtError(`${e.message} ${remotePath}`, 'list', e.code);
    } finally {
      removeTempListeners(this, listeners, 'list');
      this._resetEventFlags();
    }
  }

  /**
   * get file
   *
   * If a dst argument is provided, it must be either a string, representing the
   * local path to where the data will be put, a stream, in which case data is
   * piped into the stream or undefined, in which case the data is returned as
   * a Buffer object.
   *
   * @param {String} remotePath - remote file path
   * @param {string|stream|undefined} dst - data destination
   * @param {Object} options - options object with supported properties of readStreamOptions,
   *                          writeStreamOptions and pipeOptions.
   *
   * *Important Note*: The ability to set ''autoClose' on read/write streams and 'end' on pipe() calls
   * is no longer supported. New methods 'createReadStream()' and 'createWriteStream()' have been
   * added to support low-level access to stream objects.
   *
   * @return {Promise<String|Stream|Buffer>}
   */
  _get(rPath, dst, opts) {
    let rdr, wtr;
    return new Promise((resolve, reject) => {
      opts = {
        ...opts,
        readStreamOptions: { autoClose: true },
        writeStreamOptions: { autoClose: true },
        pipeOptions: { end: true },
      };
      rdr = this.sftp.createReadStream(rPath, opts.readStreamOptions);
      rdr.once('error', (err) => {
        reject(fmtError(`${err.message} ${rPath}`, '_get', err.code));
      });
      if (dst === undefined) {
        // no dst specified, return buffer of data
        this.debugMsg('get returning buffer of data');
        wtr = concat((buff) => {
          resolve(buff);
        });
      } else if (typeof dst === 'string') {
        // dst local file path
        this.debugMsg('get returning local file');
        const localCheck = haveLocalCreate(dst);
        if (!localCheck.status) {
          reject(
            fmtError(
              `Bad path: ${dst}: ${localCheck.details}`,
              'get',
              localCheck.code
            )
          );
          return;
        } else {
          wtr = fs.createWriteStream(dst, opts.writeStreamOptions);
        }
      } else {
        this.debugMsg('get returning data into supplied stream');
        wtr = dst;
      }
      wtr.once('error', (err) => {
        reject(
          fmtError(
            `${err.message} ${typeof dst === 'string' ? dst : '<stream>'}`,
            'get',
            err.code
          )
        );
      });
      rdr.once('end', () => {
        if (typeof dst === 'string') {
          resolve(dst);
        } else {
          resolve(wtr);
        }
      });
      rdr.pipe(wtr, opts.pipeOptions);
    });
  }

  async get(remotePath, dst, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'get');
      haveConnection(this, 'get');
      return await this._get(remotePath, dst, options);
    } catch (e) {
      throw e.custom
        ? e
        : fmtError(`${e.message} ${remotePath}`, 'get', e.code);
    } finally {
      removeTempListeners(this, listeners, 'get');
      this._resetEventFlags();
    }
  }

  /**
   * Use SSH2 fastGet for downloading the file.
   * Downloads a file at remotePath to localPath using parallel reads
   * for faster throughput.
   *
   * @param {String} remotePath
   * @param {String} localPath
   * @param {Object} options
   * @return {Promise<String>} the result of downloading the file
   */
  _fastGet(rPath, lPath, opts) {
    return new Promise((resolve, reject) => {
      this.sftp.fastGet(rPath, lPath, opts, (err) => {
        if (err) {
          this.debugMsg(`fastGet error ${err.message} code: ${err.code}`);
          reject(fmtError(`${err.message} Remote: ${rPath} Local: ${lPath}`));
        }
        resolve(`${rPath} was successfully download to ${lPath}!`);
      });
    });
  }

  async fastGet(remotePath, localPath, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'fastGet');
      haveConnection(this, 'fastGet');
      const ftype = await this.exists(remotePath);
      if (ftype !== '-') {
        const msg = `${
          !ftype ? 'No such file ' : 'Not a regular file'
        } ${remotePath}`;
        throw fmtError(msg, 'fastGet', errorCode.badPath);
      }
      const localCheck = haveLocalCreate(localPath);
      if (!localCheck.status) {
        throw fmtError(
          `Bad path: ${localPath}: ${localCheck.details}`,
          'fastGet',
          errorCode.badPath
        );
      }
      return await this._fastGet(remotePath, localPath, options);
    } catch (err) {
      this._resetEventFlags();
      throw fmtError(err, 'fastGet');
    } finally {
      removeTempListeners(this, listeners, 'fastGet');
    }
  }

  /**
   * Use SSH2 fastPut for uploading the file.
   * Uploads a file from localPath to remotePath using parallel reads
   * for faster throughput.
   *
   * See 'fastPut' at
   * https://github.com/mscdex/ssh2-streams/blob/master/SFTPStream.md
   *
   * @param {String} localPath
   * @param {String} remotePath
   * @param {Object} options
   * @return {Promise<String>} the result of downloading the file
   */
  _fastPut(lPath, rPath, opts) {
    return new Promise((resolve, reject) => {
      this.sftp.fastPut(lPath, rPath, opts, (err) => {
        if (err) {
          this.debugMsg(`fastPut error ${err.message} ${err.code}`);
          reject(
            fmtError(
              `${err.message} Local: ${lPath} Remote: ${rPath}`,
              'fastPut',
              err.code
            )
          );
        }
        this.debugMsg('fastPut file transferred');
        resolve(`${lPath} was successfully uploaded to ${rPath}!`);
      });
    });
  }

  async fastPut(localPath, remotePath, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'fastPut');
      this.debugMsg(`fastPut -> local ${localPath} remote ${remotePath}`);
      haveConnection(this, 'fastPut');
      const localCheck = haveLocalAccess(localPath);
      if (!localCheck.status) {
        throw fmtError(
          `Bad path: ${localPath}: ${localCheck.details}`,
          'fastPut',
          localCheck.code
        );
      } else if (localCheck.status && localExists(localPath) === 'd') {
        throw fmtError(
          `Bad path: ${localPath} not a regular file`,
          'fastgPut',
          errorCode.badPath
        );
      }
      return await this._fastPut(localPath, remotePath, options);
    } catch (e) {
      throw e.custom ? e : fmtError(e.message, 'fastPut', e.code);
    } finally {
      removeTempListeners(this, listeners, 'fastPut');
      this._resetEventFlags();
    }
  }

  /**
   * Create a file on the remote server. The 'src' argument
   * can be a buffer, string or read stream. If 'src' is a string, it
   * should be the path to a local file.
   *
   * @param  {String|Buffer|stream} localSrc - source data to use
   * @param  {String} remotePath - path to remote file
   * @param  {Object} options - options used for read, write stream and pipe configuration
   *                            value supported by node. Allowed properties are readStreamOptions,
   *                            writeStreamOptions and pipeOptions.
   *
   * *Important Note*: The ability to set ''autoClose' on read/write streams and 'end' on pipe() calls
   * is no longer supported. New methods 'createReadStream()' and 'createWriteStream()' have been
   * added to support low-level access to stream objects.
   *
   * @return {Promise<String>}
   */
  _put(lPath, rPath, opts) {
    let wtr, rdr;
    return new Promise((resolve, reject) => {
      opts = {
        ...opts,
        readStreamOptions: { autoClose: true },
        writeStreamOptions: { autoClose: true },
        pipeOptions: { end: true },
      };
      wtr = this.sftp.createWriteStream(rPath, opts.writeStreamOptions);
      wtr.once('error', (err) => {
        reject(fmtError(`${err.message} ${rPath}`, 'put', err.code));
      });
      wtr.once('close', () => {
        resolve(`Uploaded data stream to ${rPath}`);
      });
      if (lPath instanceof Buffer) {
        this.debugMsg('put source is a buffer');
        wtr.end(lPath);
      } else {
        rdr =
          typeof lPath === 'string'
            ? fs.createReadStream(lPath, opts.readStreamOptions)
            : lPath;
        rdr.once('error', (err) => {
          reject(
            fmtError(
              `${err.message} ${
                typeof lPath === 'string' ? lPath : '<stream>'
              }`,
              '_put',
              err.code
            )
          );
        });
        rdr.pipe(wtr, opts.pipeOptions);
      }
    });
  }

  async put(localSrc, remotePath, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'put');
      haveConnection(this, 'put');
      if (typeof localSrc === 'string') {
        const localCheck = haveLocalAccess(localSrc);
        if (!localCheck.status) {
          throw fmtError(
            `Bad path: ${localSrc} ${localCheck.details}`,
            'put',
            localCheck.code
          );
        }
      }
      return await this._put(localSrc, remotePath, options);
    } catch (e) {
      throw e.custom ? e : fmtError(e.message, 'put', e.code);
    } finally {
      removeTempListeners(this, listeners, 'put');
      this._resetEventFlags();
    }
  }

  /**
   * Append to an existing remote file
   *
   * @param  {Buffer|stream} input
   * @param  {String} remotePath
   * @param  {Object} options
   * @return {Promise<String>}
   */

  _append(input, rPath, opts) {
    return new Promise((resolve, reject) => {
      this.debugMsg(`append -> remote: ${rPath} `, opts);
      opts.flags = 'a';
      const stream = this.sftp.createWriteStream(rPath, opts);
      stream.on('error', (err) => {
        this.debugMsg(`append: Error ${err.message} appending to ${rPath}`);
        reject(fmtError(`${err.message} ${rPath}`, 'append', err.code));
      });
      stream.on('close', () => {
        this.debugMsg(`append: data appended to ${rPath}`);
        resolve(`Appended data to ${rPath}`);
      });
      if (input instanceof Buffer) {
        this.debugMsg('append: writing data buffer to remote file');
        stream.write(input);
        stream.end();
      } else {
        this.debugMsg('append: writing stream to remote file');
        input.pipe(stream);
      }
    });
  }

  async append(input, remotePath, options = {}) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'append');
      if (typeof input === 'string') {
        this.debugMsg('append: attempt to append two files - throw');
        throw fmtError(
          'Cannot append one file to another',
          'append',
          errorCode.badPath
        );
      }
      haveConnection(this, 'append');
      const fileType = await this.exists(remotePath);
      if (fileType && fileType === 'd') {
        this.debugMsg(`append: Error ${remotePath} not a file`);
        throw fmtError(
          `Bad path: ${remotePath}: cannot append to a directory`,
          'append',
          errorCode.badPath
        );
      }
      await this._append(input, remotePath, options);
    } catch (e) {
      throw e.custom ? e : fmtError(e.message, 'append', e.code);
    } finally {
      removeTempListeners(this, listeners, 'append');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Make a directory on remote server
   *
   * @param {string} remotePath - remote directory path.
   * @param {boolean} recursive - if true, recursively create directories
   * @return {Promise<String>}
   */
  _doMkdir(p) {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(p, (err) => {
        if (err) {
          this.debugMsg(`_doMkdir: Error ${err.message} code: ${err.code}`);
          if (err.code === 4) {
            //fix for windows dodgy error messages
            reject(
              fmtError(
                `Bad path: ${p} permission denied`,
                '_doMkdir',
                errorCode.badPath
              )
            );
          } else if (err.code === 2) {
            reject(
              fmtError(
                `Bad path: ${p} parent not a directory or not exist`,
                '_doMkdir',
                errorCode.badPath
              )
            );
          } else {
            reject(fmtError(`${err.message} ${p}`, '_doMkdir', err.code));
          }
        } else {
          this.debugMsg('_doMkdir: directory created');
          resolve(`${p} directory created`);
        }
      });
    });
  }

  async _mkdir(remotePath, recursive) {
    try {
      const rPath = await normalizeRemotePath(this, remotePath);
      const targetExists = await this.exists(rPath);
      if (targetExists && targetExists !== 'd') {
        throw fmtError(
          `Bad path: ${rPath} already exists as a file`,
          '_mkdir',
          errorCode.badPath
        );
      } else if (targetExists) {
        return `${rPath} already exists`;
      }
      if (!recursive) {
        return await this._doMkdir(rPath);
      }
      const dir = parse(rPath).dir;
      if (dir) {
        const dirExists = await this.exists(dir);
        if (!dirExists) {
          await this._mkdir(dir, true);
        } else if (dirExists !== 'd') {
          throw fmtError(
            `Bad path: ${dir} not a directory`,
            '_mkdir',
            errorCode.badPath
          );
        }
      }
      return await this._doMkdir(rPath);
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(`${err.message} ${remotePath}`, '_mkdir', err.code);
    }
  }

  async mkdir(remotePath, recursive = false) {
    let listeners;
    try {
      listeners = addTempListeners(this, '_mkdir');
      haveConnection(this, 'mkdir');
      return await this._mkdir(remotePath, recursive);
    } catch (err) {
      throw fmtError(`${err.message}`, 'mkdir', err.code);
    } finally {
      removeTempListeners(this, listeners, 'append');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Remove directory on remote server
   *
   * @param {string} remotePath - path to directory to be removed
   * @param {boolean} recursive - if true, remove directories/files in target
   *                             directory
   * @return {Promise<String>}
   */
  async rmdir(remotePath, recursive = false) {
    const _rmdir = (p) => {
      return new Promise((resolve, reject) => {
        this.debugMsg(`rmdir -> ${p}`);
        this.sftp.rmdir(p, (err) => {
          if (err) {
            this.debugMsg(`rmdir error ${err.message} code: ${err.code}`);
            reject(fmtError(`${err.message} ${p}`, 'rmdir', err.code));
          }
          resolve('Successfully removed directory');
        });
      });
    };

    const _dormdir = async (p, recur) => {
      try {
        if (recur) {
          const list = await this.list(p);
          if (list.length) {
            const files = list.filter((item) => item.type !== 'd');
            const dirs = list.filter((item) => item.type === 'd');
            this.debugMsg('rmdir contents (files): ', files);
            this.debugMsg('rmdir contents (dirs): ', dirs);
            for (const d of dirs) {
              await _dormdir(`${p}${this.remotePathSep}${d.name}`, true);
            }
            const promiseList = [];
            for (const f of files) {
              promiseList.push(
                this._delete(`${p}${this.remotePathSep}${f.name}`)
              );
            }
            await Promise.all(promiseList);
          }
        }
        return await _rmdir(p);
      } catch (err) {
        throw err.custom ? err : fmtError(err, '_dormdir', err.code);
      }
    };

    let listeners;
    try {
      listeners = addTempListeners(this, 'rmdir');
      haveConnection(this, 'rmdir');
      const absPath = await normalizeRemotePath(this, remotePath);
      const dirStatus = await this.exists(absPath);
      if (dirStatus && dirStatus !== 'd') {
        throw fmtError(
          `Bad path: ${absPath} not a directory`,
          'rmdir',
          errorCode.badPath
        );
      } else if (!dirStatus) {
        throw fmtError(
          `Bad path: ${absPath} No such file`,
          'rmdir',
          errorCode.badPath
        );
      } else {
        return await _dormdir(absPath, recursive);
      }
    } catch (err) {
      throw err.custom ? err : fmtError(err.message, 'rmdir', err.code);
    } finally {
      removeTempListeners(this, listeners, 'rmdir');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Delete a file on the remote SFTP server
   *
   * @param {string} remotePath - path to the file to delete
   * @param {boolean} notFoundOK - if true, ignore errors for missing target.
   *                               Default is false.
   * @return {Promise<String>} with string 'Successfully deleted file' once resolved
   *
   */
  _delete(rPath, notFoundOK) {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(rPath, (err) => {
        if (err) {
          this.debugMsg(`delete error ${err.message} code: ${err.code}`);
          if (notFoundOK && err.code === 2) {
            this.debugMsg('delete ignore missing target error');
            resolve(`Successfully deleted ${rPath}`);
          } else {
            reject(fmtError(`${err.message} ${rPath}`, 'delete', err.code));
          }
        }
        resolve(`Successfully deleted ${rPath}`);
      });
    });
  }

  async delete(remotePath, notFoundOK = false) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'delete');
      haveConnection(this, 'delete');
      return await this._delete(remotePath, notFoundOK);
    } catch (err) {
      throw err.custom ? err : fmtError(err.message, 'delete', err.code);
    } finally {
      removeTempListeners(this, listeners, 'delete');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path to the new name.
   *
   * @return {Promise<String>}
   *
   */
  _rename(fPath, tPath) {
    return new Promise((resolve, reject) => {
      this.sftp.rename(fPath, tPath, (err) => {
        if (err) {
          this.debugMsg(`rename error ${err.message} code: ${err.code}`);
          reject(
            fmtError(
              `${err.message} From: ${fPath} To: ${tPath}`,
              '_rename',
              err.code
            )
          );
        }
        resolve(`Successfully renamed ${fPath} to ${tPath}`);
      });
    });
  }

  async rename(fromPath, toPath) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'rename');
      haveConnection(this, 'rename');
      return await this._rename(fromPath, toPath);
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(`${err.message} ${fromPath} ${toPath}`, 'rename', err.code);
    } finally {
      removeTempListeners(this, listeners, 'rename');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository using the SSH extension
   * posix-rename@openssh.com using POSIX atomic rename. (Introduced in SSH 4.8)
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path  the new name.
   *
   * @return {Promise<String>}
   *
   */
  _posixRename(fPath, tPath) {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(fPath, tPath, (err) => {
        if (err) {
          this.debugMsg(`posixRename error ${err.message} code: ${err.code}`);
          reject(
            fmtError(
              `${err.message} From: ${fPath} To: ${tPath}`,
              '_posixRename',
              err.code
            )
          );
        }
        resolve(`Successful POSIX rename ${fPath} to ${tPath}`);
      });
    });
  }

  async posixRename(fromPath, toPath) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'posixRename');
      haveConnection(this, 'posixRename');
      return await this._posixRename(fromPath, toPath);
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(
            `${err.message} ${fromPath} ${toPath}`,
            'posixRename',
            err.code
          );
    } finally {
      removeTempListeners(this, listeners, 'posixRename');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Change the mode of a remote file on the SFTP repository
   *
   * @param {string} remotePath - path to the remote target object.
   * @param {number | string} mode - the new octal mode to set
   *
   * @return {Promise<String>}
   */
  _chmod(rPath, mode) {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(rPath, mode, (err) => {
        if (err) {
          reject(fmtError(`${err.message} ${rPath}`, '_chmod', err.code));
        }
        resolve('Successfully change file mode');
      });
    });
  }

  async chmod(remotePath, mode) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'chmod');
      haveConnection(this, 'chmod');
      return await this._chmod(remotePath, mode);
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(`${err.message} ${remotePath}`, 'chmod', err.code);
    } finally {
      removeTempListeners(this, listeners, 'chmod');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Upload the specified source directory to the specified destination
   * directory. All regular files and sub-directories are uploaded to the remote
   * server.
   * @param {String} srcDir - local source directory
   * @param {String} dstDir - remote destination directory
   * @param {function(String,Boolean):Boolean} filter - (Optional) The first argument is the full path of the
   * item to be uploaded and the second argument is a boolean, which will be true if the target path is for a
   * directory.  If the function returns true, the item will be uploaded
   * @returns {Promise<String>}
   */
  async _uploadDir(srcDir, dstDir, filter) {
    try {
      const absDstDir = await normalizeRemotePath(this, dstDir);
      this.debugMsg(`uploadDir <- SRC = ${srcDir} DST = ${absDstDir}`);
      const srcType = localExists(srcDir);
      if (!srcType) {
        throw fmtError(
          `Bad path: ${srcDir} not exist`,
          '_uploadDir',
          errorCode.badPath
        );
      }
      if (srcType !== 'd') {
        throw fmtError(
          `Bad path: ${srcDir}: not a directory`,
          '_uploadDir',
          errorCode.badPath
        );
      }
      const dstStatus = await this.exists(absDstDir);
      if (dstStatus && dstStatus !== 'd') {
        throw fmtError(
          `Bad path ${absDstDir} Not a directory`,
          '_uploadDir',
          errorCode.badPath
        );
      }
      if (!dstStatus) {
        await this._mkdir(absDstDir, true);
      }
      let dirEntries = fs.readdirSync(srcDir, {
        encoding: 'utf8',
        withFileTypes: true,
      });
      if (filter) {
        dirEntries = dirEntries.filter((item) =>
          filter(join(srcDir, item.name), item.isDirectory())
        );
      }
      for (const e of dirEntries) {
        const newSrc = join(srcDir, e.name);
        const newDst = `${absDstDir}${this.remotePathSep}${e.name}`;
        if (e.isDirectory()) {
          await this.uploadDir(newSrc, newDst, filter);
        } else if (e.isFile()) {
          await this._put(newSrc, newDst);
          this.client.emit('upload', { source: newSrc, destination: newDst });
        } else {
          this.debugMsg(
            `uploadDir: File ignored: ${e.name} not a regular file`
          );
        }
      }
      return `${srcDir} uploaded to ${absDstDir}`;
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(`${err.message} ${srcDir}`, '_uploadDir', err.code);
    }
  }

  async uploadDir(srcDir, dstDir, filter) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'uploadDir');
      this.debugMsg(`uploadDir -> SRC = ${srcDir} DST = ${dstDir}`);
      haveConnection(this, 'uploadDir');
      return await this._uploadDir(srcDir, dstDir, filter);
    } catch (err) {
      throw err.custom ? err : fmtError(err, 'uploadDir');
    } finally {
      removeTempListeners(this, listeners, 'chmod');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * Download the specified source directory to the specified destination
   * directory. All regular files and sub-directories are downloaded to the local
   * file system.
   * @param {String} srcDir - remote source directory
   * @param {String} dstDir - local destination directory
   * @param {function(String,Boolean):Boolean} filter - (Optional) The first argument is the full path of
   * the item to be downloaded and the second argument is a boolean, which will be true if the target path
   * is for a directory.  If the function returns true, the item will be downloaded
   * @returns {Promise<String>}
   */
  async _downloadDir(srcDir, dstDir, filter) {
    try {
      let fileList = await this._list(srcDir);
      if (filter) {
        fileList = fileList.filter((item) =>
          filter(
            `${srcDir}${this.remotePathSep}${item.name}`,
            item.type === 'd' ? true : false
          )
        );
      }
      const localCheck = haveLocalCreate(dstDir);
      if (!localCheck.status && localCheck.details === 'permission denied') {
        throw fmtError(
          `Bad path: ${dstDir}: ${localCheck.details}`,
          'downloadDir',
          localCheck.code
        );
      } else if (localCheck.status && !localCheck.type) {
        fs.mkdirSync(dstDir, { recursive: true });
      } else if (localCheck.status && localCheck.type !== 'd') {
        throw fmtError(
          `Bad path: ${dstDir}: not a directory`,
          'downloadDir',
          errorCode.badPath
        );
      }
      for (const f of fileList) {
        const newSrc = `${srcDir}${this.remotePathSep}${f.name}`;
        const newDst = join(dstDir, f.name);
        if (f.type === 'd') {
          await this._downloadDir(newSrc, newDst, filter);
        } else if (f.type === '-') {
          await this._get(newSrc, newDst);
          this.client.emit('download', { source: newSrc, destination: newDst });
        } else {
          this.debugMsg(
            `downloadDir: File ignored: ${f.name} not regular file`
          );
        }
      }
      return `${srcDir} downloaded to ${dstDir}`;
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(`${err.message} ${srcDir}`, '_downloadDir', err.code);
    }
  }

  async downloadDir(srcDir, dstDir, filter) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'downloadDir');
      haveConnection(this, 'downloadDir');
      return await this._downloadDir(srcDir, dstDir, filter);
    } catch (err) {
      throw err.custom ? err : fmtError(err, 'downloadDir', err.code);
    } finally {
      removeTempListeners(this, listeners, 'downloadDir');
      this._resetEventFlags();
    }
  }

  /**
   *
   * Returns a read stream object. This is a low level method which will return a read stream
   * connected to the remote file object specified as an argument. Client code to fully responsible
   * for managing this stream object i.e. adding any necessary listeners and disposing of the object etc.
   *
   * @param {String} remotePath - path to remote file to attach stream to
   * @param {Object} options - options to pass to the create stream process
   *
   * @returns {Object} a read stream object
   *
   */
  createReadStream(remotePath, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'createReadStream');
      haveConnection(this, 'createReadStream');
      const stream = this.sftp.createReadStream(remotePath, options);
      return stream;
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(err.message, 'createReadStream', err.code);
    } finally {
      removeTempListeners(this, listeners, 'createReadStreame');
      this._resetEventFlags();
    }
  }

  /**
   *
   * Create a write stream object connected to a file on the remote sftp server.
   * This is a low level method which will return a write stream for the remote file specified
   * in the 'remotePath' argument. Client code to responsible for managing this object once created.
   * This includes disposing of file handles, setting up any necessary event listeners etc.
   *
   * @param {String} remotePath - path to the remote file on the sftp server
   * @param (Object} options - options to pass to the create write stream process)
   *
   * @returns {Object} a stream object
   *
   */
  createWriteStream(remotePath, options) {
    let listeners;
    try {
      listeners = addTempListeners(this, 'createWriteStream');
      haveConnection(this, 'createWriteStream');
      const stream = this.sftp.createWriteStream(remotePath, options);
      return stream;
    } catch (err) {
      throw err.custom
        ? err
        : fmtError(err.message, 'createWriteStream', err.code);
    } finally {
      removeTempListeners(this, listeners, 'createWriteStream');
      this._resetEventFlags();
    }
  }

  /**
   * @async
   *
   * End the SFTP connection
   *
   * @returns {Promise<Boolean>}
   */
  end() {
    let endCloseHandler, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'end', reject);
      this.endCalled = true;
      endCloseHandler = () => {
        this.sftp = undefined;
        this.debugMsg('end: Connection closed');
        resolve(true);
      };
      this.on('close', endCloseHandler);
      if (haveConnection(this, 'end', reject)) {
        this.debugMsg('end: Have connection - calling end()');
        this.client.end();
      }
    }).finally(() => {
      this.debugMsg('end: finally clause fired');
      removeTempListeners(this, listeners, 'end');
      this.removeListener('close', endCloseHandler);
      this.endCalled = false;
      this._resetEventFlags();
    });
  }
}

module.exports = SftpClient;
