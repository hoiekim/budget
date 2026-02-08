/**
 * Download Tool: Elasticsearch Data Export
 *
 * This script downloads all data from Elasticsearch indices and saves them
 * as JSON files for migration to PostgreSQL.
 *
 * Usage:
 *   npx ts-node src/tools/download-es-data.ts
 *
 * Environment Variables:
 *   ELASTICSEARCH_HOST - ES host (default: http://localhost:9200)
 *   ELASTICSEARCH_USERNAME - ES username (optional)
 *   ELASTICSEARCH_PASSWORD - ES password (optional)
 *   OUTPUT_DIR - Directory for output files (default: current directory)
 *
 * Output Files:
 *   - backup_users.json
 *   - backup_items.json
 *   - backup_accounts.json
 *   - backup_transactions.json
 *   - backup_budgets.json
 *   - backup_sections.json
 *   - backup_categories.json
 *   - backup_charts.json
 *   - backup_snapshots.json
 */

import { importConfig } from "../server/config";
importConfig();

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const ES_HOST = process.env.ELASTICSEARCH_HOST || "http://localhost:9200";
const ES_USERNAME = process.env.ELASTICSEARCH_USERNAME;
const ES_PASSWORD = process.env.ELASTICSEARCH_PASSWORD;
const OUTPUT_DIR = process.env.OUTPUT_DIR || ".";

// Index to filename mapping
const INDICES = [{ index: "budget-6", file: "es_data.json" }];

interface ESSearchResponse {
  hits: {
    total: { value: number };
    hits: Array<{
      _id: string;
      _source: Record<string, any>;
    }>;
  };
  _scroll_id?: string;
}

async function fetchFromES(endpoint: string, method = "GET", body?: object): Promise<any> {
  const url = new URL(endpoint, ES_HOST);
  const isHttps = url.protocol === "https:";
  const httpModule = isHttps ? https : http;

  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 9200),
    path: url.pathname + url.search,
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (ES_USERNAME && ES_PASSWORD) {
    options.headers!["Authorization"] =
      "Basic " + Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString("base64");
  }

  return new Promise((resolve, reject) => {
    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function downloadIndex(indexName: string, outputFile: string): Promise<number> {
  const outputPath = path.join(OUTPUT_DIR, outputFile);
  const writeStream = fs.createWriteStream(outputPath);

  let count = 0;
  const batchSize = 1000;

  try {
    // Initial search with scroll
    let response: ESSearchResponse = await fetchFromES(`/${indexName}/_search?scroll=5m`, "POST", {
      size: batchSize,
      query: { match_all: {} },
    });

    writeStream.write("[\n");

    // Process initial batch
    for (const hit of response.hits.hits) {
      const doc = {
        _id: hit._id,
        ...hit._source,
      };
      if (count > 0) writeStream.write(",\n");
      writeStream.write(JSON.stringify(doc));
      count++;
    }

    // Continue scrolling
    while (response._scroll_id && response.hits.hits.length > 0) {
      response = await fetchFromES("/_search/scroll", "POST", {
        scroll: "5m",
        scroll_id: response._scroll_id,
      });

      for (const hit of response.hits.hits) {
        const doc = {
          _id: hit._id,
          ...hit._source,
        };
        if (count > 0) writeStream.write(",\n");
        writeStream.write(JSON.stringify(doc));
        count++;
      }
    }

    writeStream.write("]");

    // Clean up scroll
    if (response._scroll_id) {
      await fetchFromES("/_search/scroll", "DELETE", {
        scroll_id: response._scroll_id,
      }).catch(() => {}); // Ignore cleanup errors
    }
  } catch (error) {
    console.error(`Error downloading ${indexName}:`, error);
  }

  writeStream.end();
  return count;
}

async function main() {
  console.log("Elasticsearch Data Download Tool");
  console.log("=================================");
  console.log(`ES Host: ${ES_HOST}`);
  console.log(`Output Dir: ${OUTPUT_DIR}`);
  console.log();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  for (const { index, file } of INDICES) {
    process.stdout.write(`Downloading ${index}... `);
    try {
      const count = await downloadIndex(index, file);
      console.log(`${count} documents`);
    } catch (error) {
      console.log(`FAILED: ${error}`);
    }
  }

  console.log("\nDone!");
}

main().catch(console.error);
