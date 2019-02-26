// @flow
import * as I from 'immutable'
import * as ConfigGen from '../config-gen'
import * as FsGen from '../fs-gen'
import * as Saga from '../../util/saga'
import * as Config from '../../constants/config'
import * as RPCTypes from '../../constants/types/rpc-gen'
import * as Types from '../../constants/types/fs'
import * as Constants from '../../constants/fs'
import * as SafeElectron from '../../util/safe-electron.desktop'
import * as Tabs from '../../constants/tabs'
import fs from 'fs'
import type {TypedState} from '../../constants/reducer'
import {fileUIName, isWindows} from '../../constants/platform'
import logger from '../../logger'
import {spawn, execFileSync, exec} from 'child_process'
import path from 'path'
import {makeRetriableErrorHandler, makeUnretriableErrorHandler} from './shared'
import * as RouteTreeGen from '../route-tree-gen'

type pathType = 'file' | 'directory'

// pathToURL takes path and converts to (file://) url.
// See https://github.com/sindresorhus/file-url
function pathToURL(p: string): string {
  let goodPath = p.replace(/\\/g, '/')

  // Windows drive letter must be prefixed with a slash
  if (goodPath[0] !== '/') {
    goodPath = '/' + goodPath
  }

  return encodeURI('file://' + goodPath).replace(/#/g, '%23')
}

function openInDefaultDirectory(openPath: string) {
  return new Promise((resolve, reject) => {
    // Paths in directories might be symlinks, so resolve using
    // realpath.
    // For example /keybase/private/gabrielh,chris gets redirected to
    // /keybase/private/chris,gabrielh.
    fs.realpath(openPath, (err, resolvedPath) => {
      if (err) {
        reject(new Error(`No realpath for ${openPath}: ${err}`))
        return
      }
      // Convert to URL for openExternal call.
      // We use openExternal instead of openItem because it
      // correctly focuses' the Finder, and also uses a newer
      // native API on macOS.
      const url = pathToURL(resolvedPath)
      logger.info('Open URL (directory):', url)

      SafeElectron.getShell().openExternal(url, {activate: true}, err => {
        if (err) {
          reject(err)
          return
        }
        logger.info('Opened directory:', openPath)
        resolve()
      })
    })
  })
}

function getPathType(openPath: string): Promise<pathType> {
  return new Promise((resolve, reject) => {
    fs.stat(openPath, (err, stats) => {
      if (err) {
        reject(new Error(`Unable to open/stat file: ${openPath}`))
        return
      }
      if (stats.isFile()) {
        resolve('file')
      } else if (stats.isDirectory()) {
        resolve('directory')
      } else {
        reject(new Error(`Unable to open: Not a file or directory`))
      }
    })
  })
}

// _openPathInSystemFileManagerPromise opens `openPath` in system file manager.
// If isFolder is true, it just opens it. Otherwise, it shows it in its parent
// folder. This function does not check if the file exists, or try to convert
// KBFS paths. Caller should take care of those.
const _openPathInSystemFileManagerPromise = (openPath: string, isFolder: boolean) =>
  new Promise((resolve, reject) =>
    isFolder
      ? isWindows
        ? SafeElectron.getShell().openItem(openPath)
          ? resolve()
          : reject(new Error('unable to open item'))
        : openInDefaultDirectory(openPath).then(resolve, reject)
      : SafeElectron.getShell().showItemInFolder(openPath)
      ? resolve()
      : reject(new Error('unable to open item in folder'))
  )

const openLocalPathInSystemFileManager = (state, action) =>
  getPathType(action.payload.localPath)
    .then(pathType => _openPathInSystemFileManagerPromise(action.payload.localPath, pathType === 'directory'))
    .catch(makeUnretriableErrorHandler(action))

const _rebaseKbfsPathToMountLocation = (kbfsPath: Types.Path, mountLocation: string) =>
  path.resolve(
    mountLocation,
    Types.getPathElements(kbfsPath)
      .slice(1)
      .join(path.sep)
  )

const openPathInSystemFileManager = (state, action) =>
  state.fs.fileUI.driverStatus.type === 'enabled'
    ? RPCTypes.kbfsMountGetCurrentMountDirRpcPromise()
        .then(mountLocation =>
          _openPathInSystemFileManagerPromise(
            _rebaseKbfsPathToMountLocation(action.payload.path, mountLocation),
            state.fs.pathItems.get(action.payload.path, Constants.unknownPathItem).type === 'folder'
          )
        )
        .catch(err => {
          return makeRetriableErrorHandler(action)(err)
        })
    : new Promise((resolve, reject) =>
        // This usually indicates a developer error as
        // openPathInSystemFileManager shouldn't be used when FUSE integration
        // is not enabled. So just blackbar to encourage a log send.
        reject(new Error('FUSE integration is not enabled'))
      )

function waitForMount(attempt: number) {
  return new Promise((resolve, reject) => {
    // Read the KBFS path waiting for files to exist, which means it's mounted
    // TODO: should handle current mount directory
    fs.readdir(`${Config.defaultKBFSPath}${Config.defaultPrivatePrefix}`, (err, files) => {
      if (!err && files.length > 0) {
        resolve(true)
      } else if (attempt > 15) {
        reject(new Error(`${Config.defaultKBFSPath} is unavailable. Please try again.`))
      } else {
        setTimeout(() => {
          waitForMount(attempt + 1).then(resolve, reject)
        }, 1000)
      }
    })
  })
}

const fuseStatusToDokanOutdated = isWindows
  ? (status: RPCTypes.FuseStatus): ?(true | string) => {
      if (status.installAction !== 2) {
        return null
      }
      if (status && status.status && status.status.fields) {
        const field = status.status.fields.find(element => {
          return element.key === 'uninstallString'
        })
        if (field) {
          return field.value
        }
      }
      return true
    }
  : (status: ?RPCTypes.FuseStatus): ?(true | string) => null

const fuseStatusToActions = (previousStatusType: 'enabled' | 'disabled' | 'unknown') => (
  status: ?RPCTypes.FuseStatus
) => {
  if (!status) {
    return FsGen.createSetDriverStatus({driverStatus: Constants.defaultDriverStatus})
  }
  return status.kextStarted
    ? [
        FsGen.createSetDriverStatus({
          driverStatus: Constants.makeDriverStatusEnabled({
            dokanOutdated: fuseStatusToDokanOutdated(status),
          }),
        }),
        ...(previousStatusType === 'disabled' ? [FsGen.createShowFileUIBanner()] : []), // show banner for newly enabled
      ]
    : [
        FsGen.createSetDriverStatus({driverStatus: Constants.makeDriverStatusDisabled()}),
        ...(previousStatusType === 'enabled' ? [FsGen.createHideFileUIBanner()] : []), // hide banner for newly disabled
        ...(previousStatusType === 'unknown' ? [FsGen.createShowFileUIBanner()] : []), // show banner for disabled on first load
      ]
}

const refreshDriverStatus = state =>
  RPCTypes.installFuseStatusRpcPromise({bundleVersion: ''})
    .then(status =>
      isWindows && status.installStatus !== RPCTypes.installInstallStatus.installed
        ? RPCTypes.kbfsMountGetCurrentMountDirRpcPromise()
            .then(
              mountPoint =>
                new Promise(resolve =>
                  fs.access(mountPoint, fs.constants.F_OK, err => (err ? resolve(true) : resolve(false)))
                )
            )
            .then(mountExists =>
              mountExists
                ? {
                    ...status,
                    installAction: RPCTypes.installInstallAction.none,
                    installStatus: RPCTypes.installInstallStatus.installed,
                    kextStarted: true,
                  }
                : status
            )
        : Promise.resolve(status)
    )
    .then(fuseStatusToActions(state.fs.fileUI.driverStatus.type))

const fuseInstallResultIsKextPermissionError = result =>
  result &&
  result.componentResults &&
  result.componentResults.findIndex(
    c => c.name === 'fuse' && c.exitCode === Constants.ExitCodeFuseKextPermissionError
  ) !== -1

const driverEnableFuse = (state, action) =>
  RPCTypes.installInstallFuseRpcPromise().then(result =>
    fuseInstallResultIsKextPermissionError(result)
      ? [
          FsGen.createDriverKextPermissionError(),
          ...(action.payload.isRetry ? [] : [RouteTreeGen.createNavigateAppend({path: ['kextPermission']})]),
        ]
      : RPCTypes.installInstallKBFSRpcPromise()
          .then(() => waitForMount(0))
          .then(() => FsGen.createRefreshDriverStatus())
  )

function* uninstallKBFSConfirm() {
  const resp = yield Saga.callUntyped(
    () =>
      new Promise((resolve, reject) =>
        SafeElectron.getDialog().showMessageBox(
          null,
          {
            buttons: ['Remove & Restart', 'Cancel'],
            detail: `Are you sure you want to remove Keybase from ${fileUIName} and restart the app?`,
            message: `Remove Keybase from ${fileUIName}`,
            type: 'question',
          },
          resp => resolve(resp)
        )
      )
  )

  if (resp !== 0) {
    // resp is the index of the button that's clicked
    return
  }

  yield Saga.callUntyped(RPCTypes.installUninstallKBFSRpcPromise)
  yield Saga.callUntyped(() => {
    // Restart since we had to uninstall KBFS and it's needed by the service (for chat)
    SafeElectron.getApp().relaunch()
    SafeElectron.getApp().exit(0)
  })
}

const openSecurityPreferences = () => {
  SafeElectron.getShell().openExternal(
    'x-apple.systempreferences:com.apple.preference.security?General',
    {activate: true},
    err => {
      if (err) {
        return
      }
      logger.info('Opened Security Preferences')
    }
  )
}

// Invoking the cached installer package has to happen from the topmost process
// or it won't be visible to the user. The service also does this to support command line
// operations.
function installCachedDokan() {
  return new Promise((resolve, reject) => {
    logger.info('Invoking dokan installer')
    const dokanPath = path.resolve(String(process.env.LOCALAPPDATA), 'Keybase', 'DokanSetup_redist.exe')
    try {
      execFileSync(dokanPath, [])
    } catch (err) {
      logger.error('installCachedDokan caught', err)
      reject(err)
      return
    }
    // restart the service, particularly kbfsdokan
    // based on desktop/app/start-win-service.js
    const binPath = path.resolve(String(process.env.LOCALAPPDATA), 'Keybase', 'keybase.exe')
    if (!binPath) {
      return
    }
    const rqPath = binPath.replace('keybase.exe', 'keybaserq.exe')
    const args = [binPath, 'ctl', 'restart']

    spawn(rqPath, args, {
      detached: true,
      stdio: 'ignore',
    })

    resolve()
  })
}

function installDokanSaga() {
  installCachedDokan()
}

const uninstallDokanPromise = state => {
  if (
    state.fs.fileUI.driverStatus.type !== 'enabled' ||
    typeof state.fs.fileUI.driverStatus.dokanOutdated !== 'string'
  ) {
    return
  }
  const execPath: string = state.fs.fileUI.driverStatus.dokanOutdated
  logger.info('Invoking dokan uninstaller')
  return new Promise(resolve => {
    try {
      exec(execPath, {windowsHide: true}, resolve)
    } catch (e) {
      logger.error('uninstallDokan caught', e)
      resolve()
    }
  }).then(() => FsGen.createRefreshDriverStatus())
}

const openAndUploadToPromise = (state: TypedState, action: FsGen.OpenAndUploadPayload) =>
  new Promise((resolve, reject) =>
    SafeElectron.getDialog().showOpenDialog(
      SafeElectron.getCurrentWindowFromRemote(),
      {
        properties: [
          'multiSelections',
          ...(['file', 'both'].includes(action.payload.type) ? ['openFile'] : []),
          ...(['directory', 'both'].includes(action.payload.type) ? ['openDirectory'] : []),
        ],
        title: 'Select a file or folder to upload',
      },
      filePaths => resolve(filePaths || [])
    )
  )

const openAndUpload = (state, action) =>
  openAndUploadToPromise(state, action).then(localPaths =>
    localPaths.map(localPath => FsGen.createUpload({localPath, parentPath: action.payload.parentPath}))
  )

const loadUserFileEdits = (state, action) =>
  RPCTypes.SimpleFSSimpleFSUserEditHistoryRpcPromise().then(writerEdits => {
    const tlfUpdates = Constants.userTlfHistoryRPCToState(writerEdits || [])
    const updateSet = tlfUpdates
      .reduce(
        (acc: I.Set<Types.Path>, u) =>
          Types.getPathElements(u.path).reduce((acc, e, i, a) => {
            if (i < 2) return acc
            const path = Types.getPathFromElements(a.slice(0, i + 1))
            return acc.add(path)
          }, acc),
        I.Set()
      )
      .toArray()
    // TODO (songgao): make a new action that accepts an array of updates,
    // so that we only need to trigger one update through store/rpc/widget
    // for all these each time.
    return [
      ...updateSet.map(path =>
        FsGen.createFilePreviewLoad({
          identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
          path,
        })
      ),
      FsGen.createUserFileEditsLoaded({tlfUpdates}),
    ]
  })

const openFilesFromWidget = (state, {payload: {path, type}}) => [
  ConfigGen.createShowMain(),
  ...(path ? [FsGen.createOpenPathInFilesTab({path})] : [RouteTreeGen.createSwitchTo({path: [Tabs.fsTab]})]),
]

function* platformSpecificSaga(): Saga.SagaGenerator<any, any> {
  yield* Saga.chainAction<FsGen.OpenLocalPathInSystemFileManagerPayload>(
    FsGen.openLocalPathInSystemFileManager,
    openLocalPathInSystemFileManager
  )
  yield* Saga.chainAction<FsGen.OpenPathInSystemFileManagerPayload>(
    FsGen.openPathInSystemFileManager,
    openPathInSystemFileManager
  )
  yield* Saga.chainAction<ConfigGen.SetupEngineListenersPayload | FsGen.RefreshDriverStatusPayload>(
    [ConfigGen.setupEngineListeners, FsGen.refreshDriverStatus],
    refreshDriverStatus
  )
  yield* Saga.chainAction<FsGen.OpenAndUploadPayload>(FsGen.openAndUpload, openAndUpload)
  yield* Saga.chainAction<FsGen.UserFileEditsLoadPayload>(FsGen.userFileEditsLoad, loadUserFileEdits)
  yield* Saga.chainAction<FsGen.OpenFilesFromWidgetPayload>(FsGen.openFilesFromWidget, openFilesFromWidget)
  if (isWindows) {
    yield* Saga.chainAction<FsGen.DriverEnablePayload>(FsGen.driverEnable, installDokanSaga)
    yield* Saga.chainAction<FsGen.DriverDisablePayload>(FsGen.driverDisable, uninstallDokanPromise)
  } else {
    yield* Saga.chainAction<FsGen.DriverEnablePayload>(FsGen.driverEnable, driverEnableFuse)
    yield* Saga.chainGenerator<FsGen.DriverDisablePayload>(FsGen.driverDisable, uninstallKBFSConfirm)
  }
  yield* Saga.chainAction<FsGen.OpenSecurityPreferencesPayload>(
    FsGen.openSecurityPreferences,
    openSecurityPreferences
  )
}

export default platformSpecificSaga
