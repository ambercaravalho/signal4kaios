/* Beacon's own updates: find a newer release, download and check it, and install it over the app. */

export { availableUpdate, checkForUpdate, isChecking, maybeCheckForUpdate, noteLaunchVersion, type UpdateInfo } from './check';
export { applyUpdate, updatePercent, updateStep, type UpdateOutcome } from './apply';
export { detectInstaller } from './install';
