import { createHash } from 'crypto';
import { ApplicationError } from 'n8n-workflow';
import type {
	ICheckProcessedContextData,
	IProcessedDataManager,
	ICheckProcessedOptions,
	ICheckProcessedOutput,
	ProcessedDataContext,
	ProcessedDataItemTypes,
	ProcessedDataMode,
} from 'n8n-workflow';
import { Container } from 'typedi';

import { ProcessedDataRepository } from '@/databases/repositories/processed-data.repository';
import type { IProcessedDataEntries, IProcessedDataLatest } from '@/interfaces';

export class ProcessedDataHelper implements IProcessedDataManager {
	private static sortEntries(
		items: ProcessedDataItemTypes[],
		mode: ProcessedDataMode,
	): ProcessedDataItemTypes[] {
		return [...items].sort((a, b) => (ProcessedDataHelper.compareValues(mode, a, b) ? 1 : -1));
	}

	private static compareValues(
		mode: ProcessedDataMode,
		value1: ProcessedDataItemTypes,
		value2: ProcessedDataItemTypes,
	): boolean {
		if (mode === 'latestIncrementalKey') {
			const num1 = Number(value1);
			const num2 = Number(value2);
			if (!isNaN(num1) && !isNaN(num2)) {
				return num1 > num2;
			}
			throw new ApplicationError(
				'Invalid value. Only numbers are supported in mode "latestIncrementalKey"',
			);
		} else if (mode === 'latestDate') {
			const date1 = new Date(value1 as string);
			const date2 = new Date(value2 as string);

			if (!isNaN(date1.getTime()) && !isNaN(date2.getTime())) {
				return date1 > date2;
			} else {
				throw new ApplicationError(
					'Invalid value. Only valid dates are supported in mode "latestDate"',
				);
			}
		} else {
			throw new ApplicationError(
				"Invalid mode. Only 'latestIncrementalKey' and 'latestDate' are supported.",
			);
		}
	}

	private static createContext(
		context: ProcessedDataContext,
		contextData: ICheckProcessedContextData,
	): string {
		if (context === 'node') {
			console.log('contextData.node', contextData, contextData.node);
			if (!contextData.node) {
				throw new ApplicationError(
					"No node information has been provided and can so not use context 'node'",
				);
			}
			// Use the node ID to make sure that the data can still be accessed and does not get deleted
			// whenver the node gets renamed
			return `n:${contextData.node.id}`;
		}

		return '';
	}

	private static createValueHash(value: ProcessedDataItemTypes): string {
		return createHash('md5').update(value.toString()).digest('base64');
	}

	async checkProcessed(
		items: ProcessedDataItemTypes[],
		context: ProcessedDataContext,
		contextData: ICheckProcessedContextData,
		options: ICheckProcessedOptions,
	): Promise<ICheckProcessedOutput> {
		const returnData: ICheckProcessedOutput = {
			new: [],
			processed: [],
		};

		const processedData = await Container.get(ProcessedDataRepository).findOne({
			where: {
				workflowId: contextData.workflow.id as string,
				context: ProcessedDataHelper.createContext(context, contextData),
			},
		});

		if (processedData && processedData.value.mode !== options.mode) {
			throw new ApplicationError(
				'"Keep items where" is not compatible. Data got originally saved with a different "Keep items where"\'s value than the one used now. Try "Clean Database" to reset.',
			);
		}

		if (!processedData) {
			// If there is nothing it the database all items are new
			returnData.new = items;
			return returnData;
		}

		if (['latestIncrementalKey', 'latestDate'].includes(options.mode)) {
			const processedDataValue = processedData.value as IProcessedDataLatest;

			const incomingItems = ProcessedDataHelper.sortEntries(items, options.mode);
			incomingItems.forEach((item) => {
				if (ProcessedDataHelper.compareValues(options.mode, item, processedDataValue.data)) {
					returnData.new.push(item);
				} else {
					returnData.processed.push(item);
				}
			});
			return returnData;
		}

		const hashedItems = items.map((item) => ProcessedDataHelper.createValueHash(item));

		hashedItems.forEach((item, index) => {
			if ((processedData.value.data as string[]).find((entry) => entry === item)) {
				returnData.processed.push(items[index]);
			} else {
				returnData.new.push(items[index]);
			}
		});

		return returnData;
	}

	async checkProcessedAndRecord(
		items: ProcessedDataItemTypes[],
		context: ProcessedDataContext,
		contextData: ICheckProcessedContextData,
		options: ICheckProcessedOptions,
	): Promise<ICheckProcessedOutput> {
		const dbContext = ProcessedDataHelper.createContext(context, contextData);

		if (contextData.workflow.id === undefined) {
			throw new ApplicationError('Workflow has to have an ID set!');
		}

		const processedData = await Container.get(ProcessedDataRepository).findOne({
			where: {
				workflowId: contextData.workflow.id as string,
				context: ProcessedDataHelper.createContext(context, contextData),
			},
		});

		if (processedData && processedData.value.mode !== options.mode) {
			throw new ApplicationError(
				'"Keep items where" is not compatible. Data got originally saved with a different "Keep items where"\'s value than the one used now. Try "Clean Database" to reset.',
			);
		}

		if (['latestIncrementalKey', 'latestDate'].includes(options.mode)) {
			const incomingItems = ProcessedDataHelper.sortEntries(items, options.mode);

			if (!processedData) {
				// All items are new so add new entries
				await Container.get(ProcessedDataRepository).insert({
					workflowId: contextData.workflow.id.toString(),
					context: dbContext,
					value: {
						mode: options.mode,
						data: incomingItems.pop(),
					},
				});

				return {
					new: items,
					processed: [],
				};
			}

			const returnData: ICheckProcessedOutput = {
				new: [],
				processed: [],
			};

			let largestValue = processedData.value.data as ProcessedDataItemTypes;
			const processedDataValue = processedData.value as IProcessedDataLatest;

			incomingItems.forEach((item) => {
				if (ProcessedDataHelper.compareValues(options.mode, item, processedDataValue.data)) {
					returnData.new.push(item);
					if (ProcessedDataHelper.compareValues(options.mode, item, largestValue)) {
						largestValue = item;
					}
				} else {
					returnData.processed.push(item);
				}
			});

			processedData.value.data = largestValue;

			await Container.get(ProcessedDataRepository).save(processedData);

			return returnData;
		}

		const hashedItems = items.map((item) => ProcessedDataHelper.createValueHash(item));

		if (!processedData) {
			// All items are new so add new entries
			if (options.maxEntries) {
				hashedItems.splice(0, hashedItems.length - options.maxEntries);
			}
			await Container.get(ProcessedDataRepository).insert({
				workflowId: contextData.workflow.id.toString(),
				context: dbContext,
				value: {
					mode: options.mode,
					data: hashedItems,
				},
			});

			return {
				new: items,
				processed: [],
			};
		}

		const returnData: ICheckProcessedOutput = {
			new: [],
			processed: [],
		};

		const processedDataValue = processedData.value as IProcessedDataEntries;

		hashedItems.forEach((item, index) => {
			if (processedDataValue.data.find((entry) => entry === item)) {
				returnData.processed.push(items[index]);
			} else {
				returnData.new.push(items[index]);
				processedDataValue.data.push(item);
			}
		});

		if (options.maxEntries) {
			processedDataValue.data.splice(0, processedDataValue.data.length - options.maxEntries);
		}

		await Container.get(ProcessedDataRepository).save(processedData);

		return returnData;
	}

	async removeProcessed(
		items: ProcessedDataItemTypes[],
		context: ProcessedDataContext,
		contextData: ICheckProcessedContextData,
		options: ICheckProcessedOptions,
	): Promise<void> {
		if (['latestIncrementalKey', 'latestDate'].includes(options.mode)) {
			throw new ApplicationError('Removing processed data is not possible in mode "latest"');
		}

		const processedData = await Container.get(ProcessedDataRepository).findOne({
			where: {
				workflowId: contextData.workflow.id as string,
				context: ProcessedDataHelper.createContext(context, contextData),
			},
		});

		if (!processedData) {
			return;
		}

		const hashedItems = items.map((item) => ProcessedDataHelper.createValueHash(item));

		const processedDataValue = processedData.value as IProcessedDataEntries;

		hashedItems.forEach((item) => {
			const index = processedDataValue.data.findIndex((value) => value === item);
			if (index !== -1) {
				processedDataValue.data.splice(index, 1);
			}
		});

		await Container.get(ProcessedDataRepository).save(processedData);
	}

	async clearAllProcessedItems(
		context: ProcessedDataContext,
		contextData: ICheckProcessedContextData,
		options: ICheckProcessedOptions,
	): Promise<void> {
		console.log(options);
		await Container.get(ProcessedDataRepository).delete({
			workflowId: contextData.workflow.id as string,
			context: ProcessedDataHelper.createContext(context, contextData),
		});
	}
}
