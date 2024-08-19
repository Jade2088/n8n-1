import type { IDataObject } from './Interfaces';
import util from 'util';

const defaultPropertyDescriptor = Object.freeze({ enumerable: true, configurable: true });

function augment<T>(value: T): T {
	if (typeof value !== 'object' || value === null || value instanceof RegExp) return value;
	if (value instanceof Date) return new Date(value.valueOf()) as T;
	if (value instanceof Uint8Array) return value.slice() as T;

	// eslint-disable-next-line @typescript-eslint/no-use-before-define
	if (Array.isArray(value)) return augmentArray(value) as T;

	// eslint-disable-next-line @typescript-eslint/no-use-before-define
	return augmentObject(value) as T;
}

export function augmentArray<T>(data: T[]): T[] {
	if ('isAugmented' in data) return data;

	let newData: unknown[] | undefined = undefined;

	function getData(): unknown[] {
		if (newData === undefined) {
			newData = [...data];
		}
		return newData;
	}

	return new Proxy(data, {
		deleteProperty(_target, key: string) {
			return Reflect.deleteProperty(getData(), key);
		},
		get(target, key: string, receiver): unknown {
			const value = Reflect.get(newData ?? target, key, receiver) as unknown;
			if (typeof value === 'object') {
				if (value === null || util.types.isProxy(value)) {
					return value;
				}
				newData = getData();
				if (Array.isArray(value)) {
					Reflect.set(newData, key, augmentArray(value));
				} else {
					// eslint-disable-next-line @typescript-eslint/no-use-before-define
					Reflect.set(newData, key, augmentObject(value as IDataObject));
				}
				return Reflect.get(newData, key);
			}
			return value;
		},
		getOwnPropertyDescriptor(target, key) {
			if (newData === undefined) {
				return Reflect.getOwnPropertyDescriptor(target, key);
			}

			if (key === 'length') {
				return Reflect.getOwnPropertyDescriptor(newData, key);
			}

			return Object.getOwnPropertyDescriptor(data, key) ?? defaultPropertyDescriptor;
		},
		has(target, key) {
			if (key === 'isAugmented') return true;
			return Reflect.has(newData ?? target, key);
		},
		ownKeys(target) {
			return Reflect.ownKeys(newData ?? target);
		},
		set(_target, key: string, newValue: unknown) {
			// Always proxy all objects. Like that we can check in get simply if it
			// is a proxy and it does then not matter if it was already there from the
			// beginning and it got proxied at some point or set later and so theoretically
			// does not have to get proxied
			return Reflect.set(getData(), key, augment(newValue));
		},
	});
}

export function augmentObject<T extends object>(data: T): T {
	if ('isAugmented' in data) return data;

	const newData = {} as IDataObject;
	const deletedProperties = new Set<string | symbol>();

	return new Proxy(data, {
		get(target, key: string, receiver): unknown {
			if (deletedProperties.has(key)) {
				return undefined;
			}

			if (newData[key] !== undefined) {
				return newData[key];
			}

			const value = Reflect.get(target, key, receiver);
			if (value !== null && typeof value === 'object') {
				if (Array.isArray(value)) {
					newData[key] = augmentArray(value);
				} else {
					newData[key] = augmentObject(value as IDataObject);
				}

				return newData[key];
			}

			return value;
		},
		deleteProperty(target, key: string) {
			if (key in newData) {
				delete newData[key];
			}
			if (key in target) {
				deletedProperties.add(key);
			}

			return true;
		},
		set(target, key: string, newValue: unknown) {
			if (newValue === undefined) {
				if (key in newData) {
					delete newData[key];
				}
				if (key in target) {
					deletedProperties.add(key);
				}
				return true;
			}

			newData[key] = newValue as IDataObject;

			if (deletedProperties.has(key)) {
				deletedProperties.delete(key);
			}

			return true;
		},
		has(target, key) {
			if (key === 'isAugmented') return true;
			if (deletedProperties.has(key)) return false;
			return Reflect.has(newData, key) || Reflect.has(target, key);
		},
		ownKeys(target) {
			const originalKeys = Reflect.ownKeys(target);
			const newKeys = Object.keys(newData);
			return [...new Set([...originalKeys, ...newKeys])].filter(
				(key) => !deletedProperties.has(key),
			);
		},

		getOwnPropertyDescriptor(_target, key) {
			if (deletedProperties.has(key)) return undefined;
			return Object.getOwnPropertyDescriptor(key in newData ? newData : data, key);
		},
	});
}
