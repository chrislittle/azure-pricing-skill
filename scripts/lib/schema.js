'use strict';
// Component schema: the single source of truth for what each component needs,
// what to ask a customer, and sensible defaults. Used by `azp questions` and spec validation.
const S = {
  vm: { label: 'Virtual machine', fields: {
    sku: { req: true, ask: 'Do not ask for a SKU. Ask vCPU, memory, workload type; then run `azp vm-suggest`.' },
    os: { def: 'linux', enum: ['linux', 'windows', 'windows-ahb', 'rhel', 'rhel-byos', 'sles', 'ubuntu-pro', 'rhel-ha', 'rhel-sap', 'rhel-sap-ha', 'sles-sap', 'sles-hpc', 'sles-basic'], ask: 'Which operating system? If Windows: do you own Windows Server licenses with Software Assurance? If Red Hat: do you already have Red Hat subscriptions? Special images: Ubuntu Pro (ubuntu-pro), RHEL with high availability (rhel-ha), RHEL for SAP (rhel-sap, or rhel-sap-ha with HA), SUSE for SAP (sles-sap), SUSE for HPC (sles-hpc), SUSE patching only (sles-basic).' },
    count: { def: 1, ask: 'How many identical servers?' },
    hours: { def: 730, ask: 'Does it run all the time, or only part of the day? (730 hours = always on)' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare 1- and 3-year reservations and savings plans? Only worth it if it runs most of the month.' },
    sqlLicense: { def: 'none', enum: ['none', 'web', 'standard', 'enterprise'], ask: 'Is SQL Server installed on it? Which edition (Web, Standard, Enterprise), and do you already own SQL Server licenses with Software Assurance (then none)?' }, biztalk: { def: 'none', enum: ['none', 'standard', 'enterprise'], ask: 'Windows only: is BizTalk Server installed, and which edition (Standard or Enterprise)?' }, oracleJava: { def: false, ask: 'Do you need the Oracle Java SE subscription billed through Azure (per vCPU)?' }, licenseTerm: { def: 'payg', enum: ['payg', '1y', '3y'], ask: 'Red Hat or SUSE images only: will you commit to a 1- or 3-year software subscription for the Linux license (sold for rhel, sles and sles-sap)?' } } },
  disk: { label: 'Managed disk', fields: {
    diskType: { def: 'standard-ssd', enum: ['standard-hdd', 'standard-ssd', 'premium-ssd', 'premium-v2'], ask: 'Do not ask for a disk type. Ask how much space and whether it needs to be fast (database, heavy I/O) or just hold data. Map: plain -> standard-ssd; fast -> premium-ssd; fast and large or precise IOPS -> premium-v2.' },
    sizeGiB: { req: true, min: 1, ask: 'How much disk space (GB)?' },
    iops: { int: true, min: 0, ask: 'Only if performance matters: required IOPS / throughput, if known.' },
    throughputMBps: { min: 0 },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS'], ask: 'Must the disk survive a datacenter (zone) failure? If yes ZRS (costs ~50% more).' },
    count: { def: 1, int: true, min: 1 }, role: { ask: 'Label it: OS disk or data disk.' },
    transactionsPerMonth: { min: 0, ask: 'Standard HDD / SSD only: roughly how many disk transactions (reads and writes) per month, if known? Premium disks do not bill transactions.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y'], ask: 'Premium SSD of 1 TB or more that stays for a year? Compare a 1-year disk reservation; otherwise pay-as-you-go.' },
    bursting: { def: false, ask: 'Only for premium disks above 512 GiB (P30-P80): does the workload spike far above the disk\'s normal IOPS for short periods? Then enable on-demand bursting.' },
    burstIops: { int: true, min: 0, max: 30000, ask: 'With bursting: the highest IOPS the spikes reach (max 30,000).' }, burstMinutesPerDay: { def: 30, min: 0, max: 1440, ask: 'With bursting: minutes per working day spent at that peak.' }, burstDaysPerMonth: { def: 22, int: true, min: 0, max: 31, ask: 'With bursting: working days per month.' },
    additionalMounts: { def: 0, int: true, min: 0, ask: 'Shared disk (clustered VMs, e.g. failover cluster): how many extra VMs mount each disk? Otherwise 0.' },
    confidential: { def: false, ask: 'Is this the OS disk of a Confidential VM that needs confidential OS disk encryption?' } } },
  'public-ip': { label: 'Public IP', fields: { tier: { def: 'standard', enum: ['standard', 'standard-v2', 'global', 'basic-static', 'basic-dynamic'], ask: 'Do not ask for a tier. Normal public address -> standard; address in front of a cross-region load balancer -> global; basic-* only if the person insists on the old Basic SKU (being retired).' }, count: { def: 1, ask: 'How many public IP addresses?' }, hours: { def: 730, ask: 'Are they allocated all month? (730 hours = always)' }, prefixAddresses: { def: 0, int: true, min: 0, max: 256, ask: 'Do you need a reserved block of consecutive public IPs (a public IP prefix)? How many addresses: 2, 4, 8, 16, 32, 64, 128 or 256. Otherwise 0.' }, prefixTier: { def: 'standard', enum: ['standard', 'global'] } } },
  bandwidth: { label: 'Internet egress', fields: { egressGB: { req: true, ask: 'Roughly how much data goes out to the internet each month? If unknown, use 100 GB and set guess:true.' }, guess: { def: false } } },
  'load-balancer': { label: 'Standard Load Balancer', fields: { tier: { def: 'regional', enum: ['regional', 'global'], ask: 'A regional load balancer, or a Global (cross-region) load balancer in front of regional ones?' }, rules: { def: 5, int: true, min: 0, ask: 'How many load-balancing and outbound rules? The first 5 are included in the hourly price; 0 rules costs nothing hourly. Inbound NAT rules are free and do not count (pricing page: "Inbound NAT rules don\'t count in the total number of rules.").' }, processedGB: { def: 0, min: 0, ask: 'Approximate GB per month through the load balancer.' }, hours: { def: 730, min: 0, max: 744, ask: 'Does it run all month (730 hours) or fewer hours?' } } },
  'app-gateway': { label: 'Application Gateway v2', fields: { tier: { def: 'v2', enum: ['v2', 'basic-v2'], ask: 'Do not ask for a tier. Small test or internal site with no firewall needs -> basic-v2; anything else -> v2.' }, waf: { def: true, ask: 'Public web app? WAF (web application firewall) is recommended.' }, captchaSessions: { def: 0, ask: 'Only if the firewall will challenge visitors with CAPTCHA: roughly how many challenge sessions per month? Otherwise 0.' }, capacityUnits: { def: 1, ask: 'Average capacity units; 1-2 for small sites.' }, hours: { def: 730 } } },
  aks: { label: 'AKS cluster management', fields: { tier: { def: 'free', enum: ['free', 'standard', 'premium'], ask: 'Is this production that needs an uptime SLA? Production -> standard. Nodes are separate "vm" + "disk" components.' }, count: { def: 1, int: true, min: 1, ask: 'How many clusters of this tier?' }, hours: { def: 730, min: 0, max: 744, ask: 'Does it run all month (730 hours) or fewer hours?' } } },
  'app-service': { label: 'App Service plan', fields: { plan: { req: true, ask: 'Ask CPU/memory per instance, then map: just trying it out -> F1 (free) or D1 (shared, Windows only); small dev/test -> B1/B2/B3; production -> 1/4 P0v3, 2/8 P1v3, 4/16 P2v3, 8/32 P3v3, 2/16 P1mv3 (more memory: P2mv3..P5mv3); newest generation P0v4..P3v4 / P1mv4..P5mv4. Older S1-S3 and P1v2-P3v2 only if asked. Isolated plans are a different component.' }, os: { def: 'linux', enum: ['linux', 'windows'], ask: 'Windows or Linux app? .NET Framework apps need Windows; most other stacks run on Linux (cheaper).' }, count: { def: 1, ask: 'How many instances (2+ for redundancy)?' }, hours: { def: 730, ask: 'Does it run all the time? (730 hours = always on)' }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare 1- and 3-year reservations and savings plans? Only worth it for steady production use; offered on Premium v3 and v4 plans.' }, ipSslConnections: { def: 0, ask: 'How many custom domains need a dedicated IP address for SSL (IP SSL)? Most sites use SNI SSL, which is free: answer 0.' }, customDomains: { def: 0, ask: 'Do you need to buy new domain names from Azure? How many?' }, standardCertificates: { def: 0, ask: 'How many App Service certificates (single domain, 1 year) will you buy? Zero if you bring your own or use free managed certificates.' }, wildcardCertificates: { def: 0, ask: 'How many wildcard App Service certificates (1 year) will you buy?' } } },
  functions: { label: 'Azure Functions', fields: { plan: { def: 'consumption', enum: ['consumption', 'flex'] }, executions: { req: true, ask: 'Calls per month?' }, gbSeconds: { ask: 'Or give durationMs and memoryMB per call and the engine computes GB-seconds.' }, durationMs: {}, memoryMB: { ask: 'Consumption plan: memory used per call in MB (up to 1,536; billed rounded up to 128 MB)?' }, instanceMemoryMB: { enum: [512, 2048, 4096], ask: 'Flex Consumption: instance memory size (512, 2048 or 4096 MB; 2048 is the default)?' }, alwaysReadyInstances: { int: true, min: 0, ask: 'Flex Consumption: how many always-ready (pre-warmed, always running) instances do you need to avoid cold starts?' }, alwaysReadyExecutions: { ask: 'Flex Consumption: how many calls per month do the always-ready instances serve?' }, commitment: { def: 'payg', enum: ['payg', 'sp1y', 'sp3y'], ask: 'Flex Consumption: will you commit to an Azure savings plan for compute for 1 or 3 years?' } } },
  'container-apps': { label: 'Container Apps (consumption)', fields: { apps: { def: 1 }, vcpu: { def: 0.5 }, memGiB: { def: 1 }, replicas: { def: 1, ask: 'Minimum replicas always running?' }, hours: { def: 730 }, activeFraction: { def: 1, ask: 'Fraction of time replicas are actively processing (1 = worst case).' }, requests: { def: 0 } } },
  'sql-database': { label: 'Azure SQL Database (vCore)', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'business-critical', 'hyperscale'], ask: 'General Purpose for most workloads, Business Critical for low-latency / read scale-out, Hyperscale for very large databases (over 4 TB)?' }, vcores: { req: true, int: true, min: 1, max: 128, ask: 'How many vCores (for serverless: the maximum)?' }, storageGB: { def: 32, min: 1 }, ahb: { def: false, ask: 'Do you own SQL Server licenses with Software Assurance?' }, hours: { def: 730 }, compute: { def: 'provisioned', enum: ['provisioned', 'serverless'], ask: 'Is the database busy around the clock (provisioned) or intermittent with idle periods (serverless with auto-pause)?' }, minVcores: { min: 0.5, ask: 'Serverless minimum vCores (0.5 is typical)?' }, avgVcores: { min: 0, ask: 'Serverless: average vCores used while the database is active?' }, activeHoursPerMonth: { min: 0, max: 744, ask: 'Serverless: roughly how many hours a month is the database active (not paused)?' }, hardware: { def: 'standard-series', enum: ['standard-series', 'fsv2-series', 'premium-series', 'premium-series-memory-optimized', 'dc-series', 'm-series'], ask: 'Any hardware requirement (confidential DC-series, memory-optimized M-series) or standard-series?' }, zoneRedundant: { def: false, ask: 'Must the database survive an availability zone failure (zone redundancy)?' }, haReplicas: { int: true, min: 0, max: 4, ask: 'Hyperscale: how many high-availability replicas (0-4)?' }, namedReplicas: { int: true, min: 0, max: 30, ask: 'Hyperscale: how many named (read scale-out) replicas?' }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Will compute run steadily enough to commit for 1 or 3 years? Reservation (ri1y, ri3y) or the more flexible savings plan for databases (sp1y, sp3y)?' }, backupStorageGB: { min: 0, ask: 'How much point-in-time backup storage do you expect in total (GB)?' }, ltrStorageGB: { min: 0, ask: 'How much long-term retention backup storage (GB)?' }, backupRedundancy: { def: 'GRS', enum: ['LRS', 'ZRS', 'GRS', 'GZRS'], ask: 'Backup storage redundancy: locally, zone, geo or geo-zone redundant (the default is geo-redundant, GRS)?' } } },
  'sql-mi': { label: 'Azure SQL Managed Instance', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'business-critical'] }, vcores: { req: true, enum: [4, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 128] }, storageGB: { def: 32 }, ahb: { def: false }, hours: { def: 730 } } },
  postgres: { label: 'PostgreSQL Flexible Server', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'memory-optimized', 'burstable'], ask: 'Dev/test or lightly used -> burstable; production -> general-purpose; memory-hungry -> memory-optimized.' }, series: { def: 'Ddsv5' }, vcores: { req: true, int: true, min: 1, max: 128 }, storageGB: { def: 128, min: 1 }, ha: { def: false, ask: 'Need high availability (standby in another zone)?' }, hours: { def: 730 }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Will the server run steadily enough to commit for 1 or 3 years? Reservation (ri1y, ri3y) or the more flexible savings plan for databases (sp1y, sp3y)?' }, readReplicas: { int: true, min: 0, max: 10, ask: 'How many read replicas do you need?' }, storageType: { def: 'ssd', enum: ['ssd', 'premium-ssd-v2', 'ultra-disk'], ask: 'Standard SSD storage, Premium SSD v2 or Ultra Disk (independently provisioned IOPS and throughput)?' }, provisionedIops: { int: true, min: 3000, max: 80000, ask: 'Premium SSD v2: how many IOPS (3,000 are included)?' }, provisionedThroughputMBps: { min: 125, ask: 'Premium SSD v2: how many MB/s throughput (125 are included)?' }, additionalIops: { int: true, min: 0, ask: 'Extra provisioned IOPS above the storage-size baseline?' }, backupStorageGB: { min: 0, ask: 'How much backup storage do you expect in total (GB)?' }, backupRedundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS'] }, autonomousTuning: { def: false, ask: 'Enable autonomous tuning (billed per vCore-hour)?' }, extendedSupport: { def: false, ask: 'Is the server on a major version past community end of life (extended support surcharge)?' }, burstableSize: { enum: ['B1ms', 'B2s', 'B2ms', 'B4ms', 'B8ms', 'B12ms', 'B16ms', 'B20ms'] } } },
  mysql: { label: 'MySQL Flexible Server', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'memory-optimized', 'burstable', 'business-critical'], ask: 'Dev/test or lightly used -> burstable; production -> general-purpose; memory-hungry -> memory-optimized; highest performance -> business-critical.' }, series: { def: 'Ddsv5' }, vcores: { req: true, int: true, min: 1, max: 128 }, storageGB: { def: 128, min: 1 }, ha: { def: false }, hours: { def: 730 }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Will the server run steadily enough to commit for 1 or 3 years? Reservation (ri1y, ri3y) or the more flexible savings plan for databases (sp1y, sp3y)?' }, readReplicas: { int: true, min: 0, max: 10, ask: 'How many read replicas do you need?' }, storageType: { def: 'ssd', enum: ['ssd', 'premium-ssd-v2'], ask: 'Standard SSD storage or Premium SSD v2 (independently provisioned IOPS and throughput)?' }, provisionedIops: { int: true, min: 3000, max: 80000, ask: 'Premium SSD v2: how many IOPS (3,000 are included)?' }, provisionedThroughputMBps: { min: 125, ask: 'Premium SSD v2: how many MB/s throughput (125 are included)?' }, additionalIops: { int: true, min: 0, ask: 'Extra provisioned IOPS above the storage-size baseline?' }, backupStorageGB: { min: 0, ask: 'How much backup storage do you expect in total (GB)?' }, backupRedundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS'] }, extendedSupport: { def: false, ask: 'Is the server on a major version past community end of life (extended support surcharge)?' }, burstableSize: { enum: ['B1s', 'B1ms', 'B2s', 'B2ms', 'B4ms', 'B8ms', 'B12ms', 'B16ms', 'B20ms'] }, acceleratedLogs: { def: false, ask: 'General Purpose server that needs accelerated logs (faster write latency, billed per server-hour)?' }, paidIoOps: { min: 0, ask: 'Storage I/O operations per month beyond the free allowance (paid IO)?' }, zoneRedundantStorage: { def: false, ask: 'Zone-redundant storage for the server?' } } },
  cosmos: { label: 'Azure Cosmos DB (NoSQL)', fields: { mode: { def: 'autoscale', enum: ['provisioned', 'autoscale', 'serverless'] }, ru: { ask: 'provisioned RU/s (minimum 400, in steps of 100)', min: 400, int: true }, maxRU: { ask: 'autoscale maximum RU/s (the highest the workload will reach; minimum 1,000, in steps of 1,000)', min: 1000, int: true }, averageUtilizationPct: { min: 10, max: 100, ask: 'On average, what percent of the autoscale maximum does the workload use (10 to 100)? Leave it out to price the worst case, 100%.' }, requestUnits: { min: 0, ask: 'serverless RUs per month' }, storageGB: { def: 0, min: 0 }, regions: { def: 1, int: true, min: 1 }, zoneRedundant: { def: false, ask: 'Do you want availability zones in every region (zone redundancy)?' }, zoneRedundantRegions: { int: true, min: 0, ask: 'In how many of the regions do you want availability zones?' }, perPartitionFailover: { def: false, ask: 'Do you want per-partition automatic failover (billed at the Business Critical, multi-region-write rate)?' }, semanticRerankerQueries: { min: 0, ask: 'How many semantic reranker queries per month?' }, hours: { def: 730 }, multiRegionWrites: { def: false, ask: 'Do you need writes accepted in more than one region (multi-region writes)?' }, freeTier: { def: false, ask: 'Is this the one account per subscription that uses the Cosmos DB free tier (1,000 RU/s and 25 GB free)?' }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Will the provisioned throughput be committed for 1 or 3 years (reserved capacity)?' }, backup: { def: 'periodic', enum: ['periodic', 'continuous-7d', 'continuous-30d'], ask: 'Do you need point-in-time restore (continuous backup, 7 or 30 days) or is the default periodic backup enough?' }, backupStorageGB: { min: 0, ask: 'How much extra periodic backup storage beyond the two free copies (GB)?' }, backupRedundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS'] }, restoreGB: { min: 0, ask: 'How much data would you restore from continuous backup per month (GB)?' }, analyticalStorageGB: { min: 0, ask: 'How much analytical store (Synapse Link / Fabric mirroring) storage do you need (GB)?' }, analyticalWriteOps: { min: 0, ask: 'Analytical store write operations per month?' }, analyticalReadOps: { min: 0, ask: 'Analytical store read operations per month?' }, gatewaySku: { enum: ['D2s', 'D4s', 'D8s', 'D16s', 'D32s', 'D64s', 'E2s', 'E4s', 'E8s', 'E16s', 'E32s', 'E64s'], ask: 'Do you need a dedicated gateway (integrated cache)? Which size (D = general purpose, E = memory optimized)?' }, gatewayNodes: { def: 1, int: true, min: 1, ask: 'How many dedicated gateway nodes?' } } },
  blob: { label: 'Blob storage', fields: { tier: { def: 'Hot', enum: ['Hot', 'Cool', 'Cold', 'Archive', 'Premium'], ask: 'How often is the data read? Daily -> Hot; monthly -> Cool; a few times a year -> Cold; almost never -> Archive. Premium only for very low latency or very many small operations (SSD).' }, redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'GZRS', 'RA-GRS', 'RA-GZRS'], ask: 'Must the data survive a datacenter failure (ZRS) or a whole-region disaster (GRS, GZRS)? Cheapest is LRS; Premium supports LRS and ZRS only.' }, namespace: { def: 'flat', enum: ['flat', 'hierarchical'], ask: 'Does the account need a hierarchical namespace (real directories, SFTP, Data Lake-style folders on block blob)? Yes -> hierarchical; plain object storage -> flat. A full Azure Data Lake Storage Gen2 analytics estimate is the separate data-lake-storage type.' }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Will 100 TiB or more stay stored for a year or longer? Then compare 1- or 3-year reserved capacity; otherwise pay-as-you-go.' }, listOps: { def: 0, min: 0, int: true, ask: 'List and create-container operations per month, if known.' }, iterativeWriteOps: { def: 0, min: 0, int: true }, iterativeReadOps: { def: 0, min: 0, int: true }, indexTags: { def: 0, ask: 'Only if blob index tags are used: how many tags in total?' }, capacityGB: { req: true, min: 0, ask: 'How much data is stored in total (GB or TB)? This is separate from how much is downloaded each month.' }, writeOps: { def: 0, min: 0, int: true }, readOps: { def: 0, min: 0, int: true }, otherOps: { def: 0, min: 0, int: true }, retrievalGB: { def: 0 }, priorityReadOps: { def: 0, min: 0, int: true, ask: 'Archive only: how many high-priority (rehydration) read operations per month?' }, priorityRetrievalGB: { def: 0, min: 0, ask: 'Archive only: how many GB retrieved at high priority per month?' }, sftpHours: { def: 0, min: 0, max: 744, ask: 'Is SFTP enabled on the account? If so, how many hours a month (730 = always on)?' } } },
  files: { label: 'Azure Files', fields: { model: { def: 'provisioned-v2-hdd', enum: ['provisioned-v2-hdd', 'provisioned-v2-ssd', 'payg-hot', 'payg-cool', 'payg-transaction-optimized', 'premium-v1'], ask: 'Office documents / user shares -> provisioned-v2-hdd; latency-sensitive apps -> provisioned-v2-ssd; classic premium (v1) provisioned shares -> premium-v1.' }, capacityGB: { req: true, min: 0, ask: 'How much data is in the file shares in total (GB or TB)?' }, redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'GZRS'] }, snapshotGB: { min: 0, ask: 'How much changed data do the share snapshots hold in total (GB)?' }, commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Will the share capacity be committed for 1 or 3 years (reserved capacity)?' }, iops: { int: true, min: 0, ask: 'Provisioned v2 only, if the application needs a specific IOPS figure (otherwise the recommended value for the share size is used).' }, throughputMBps: { min: 0, ask: 'Provisioned v2 only, if the application needs a specific throughput in MiB/s (otherwise the recommended value is used).' }, writeOps: { int: true, min: 0 }, readOps: { int: true, min: 0 }, listOps: { int: true, min: 0 }, otherOps: { int: true, min: 0, ask: 'Pay-as-you-go shares: how many other (protocol) operations per month, such as open, close and attribute reads?' }, metadataGB: { min: 0, ask: 'Hot or cool pay-as-you-go shares: how much file-system metadata (ACLs, properties) is stored (GB)? It is often a small fraction of the data.' }, retrievalGB: { min: 0, ask: 'Cool shares: how much data is read back or moved to a hotter tier per month (GB)?' }, geoReplicationGB: { min: 0, ask: 'GRS or GZRS shares: how much data is written per month and so replicated to the secondary region (GB)?' }, softDeletedGB: { min: 0, ask: 'Provisioned v2: how much soft-deleted share data is kept during the retention period (GiB)?' }, burstBandwidthGiB: { min: 0, ask: 'Premium v1 shares with paid bursting: GiB of burst bandwidth per month?' }, burstTransactionsMillions: { min: 0, ask: 'Premium v1 shares with paid bursting: millions of burst transactions per month?' } } },
  'log-analytics': { label: 'Log Analytics', fields: { ingestGBPerDay: { req: true, ask: 'Roughly how many GB of logs per day?' }, retentionDays: { def: 31, min: 4, max: 4383, int: true, ask: 'How many days should logs be kept in total (up to 730 days interactive, up to 12 years / 4,383 days including long-term retention)?' }, commitmentTier: { enum: [100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 25000, 50000], ask: 'Do you ingest at least 100 GB/day steadily (commitment tier)? Which tier?' }, basicLogsGBPerDay: { ask: 'How many GB/day are high-volume, rarely queried logs that could go to Basic Logs?' }, auxiliaryLogsGBPerDay: { ask: 'How many GB/day could go to Auxiliary Logs (cheapest, for long-term/audit data)?' }, searchQueryScannedGB: { ask: 'How many GB per month will queries scan in Basic/Auxiliary logs?' }, searchJobScannedGB: { ask: 'How many GB per month will search jobs scan?' }, restoreGB: { ask: 'How many GB of archived data will you restore at a time?' }, restoreDays: { def: 1, min: 0, ask: 'For how many days is restored data kept (billed for at least 12 hours, and at least 2 TB)?' }, replicatedGBPerDay: { ask: 'If the workspace is replicated to a second region, how many GB/day are replicated?' }, transformIncomingGBPerDay: { ask: 'How many GB/day arrive at ingestion-time transformations (data collection rules)?' }, transformDroppedPct: { min: 0, max: 100, ask: 'What percent of that data do the transformations drop (filter out)?' }, exportGBPerDay: { ask: 'How many GB/day will you export out of the workspace (data export rule)?' }, archiveGB: { ask: 'How many GB of long-term (archive) retention beyond interactive retention?' } } },
  openai: { label: 'Azure OpenAI (Foundry Models)', fields: { model: { req: true, ask: 'Use `azp models` to list; recommend a current small model unless quality needs a larger one.' }, inputTokens: { req: true, int: true, min: 0, ask: 'Uncached input (prompt) tokens per month, excluding cached tokens and, for long-context models, tokens in requests above 272K?' }, cachedInputTokens: { def: 0, int: true, min: 0, ask: 'Cached input tokens per month (prompt-cache hits)?' }, cacheWriteTokens: { int: true, min: 0, ask: 'Prompt-cache write tokens per month (GPT-5.6 family)?' }, cachedAudioInputTokens: { int: true, min: 0, ask: 'Cached audio input tokens per month (realtime)?' }, cachedImageInputTokens: { int: true, min: 0, ask: 'Cached image input tokens per month (realtime)?' }, longContextInputTokens: { int: true, min: 0, ask: 'Input tokens per month in requests above 272K tokens of context (GPT-5.4/5.5/5.6 bill these at higher long-context rates)?' }, longContextCachedInputTokens: { int: true, min: 0, ask: 'Cached input tokens in requests above 272K context?' }, longContextCacheWriteTokens: { int: true, min: 0, ask: 'Cache write tokens in requests above 272K context?' }, longContextOutputTokens: { int: true, min: 0, ask: 'Output tokens in requests above 272K context?' }, outputTokens: { req: true, int: true, min: 0, ask: 'Embeddings produce no output tokens; pass 0.' }, deployment: { def: 'global', enum: ['global', 'datazone', 'regional'], ask: 'Must data stay inside one region (regional) or one geography (EU/US data zone), or is global routing fine?' }, processing: { def: 'standard', enum: ['standard', 'batch', 'priority'], ask: 'Interactive requests (standard), offline jobs that can wait up to 24 hours (batch), or latency-critical (priority)?' }, fineTuned: { def: false, ask: 'Are you fine-tuning the model and calling your fine-tuned deployment?' }, trainingTokens: { int: true, min: 0, ask: 'Fine-tuning: total training tokens (tokens in the training file x epochs)?' }, hostingHours: { min: 0, max: 744, ask: 'Fine-tuning: how many hours a month is the fine-tuned deployment hosted?' }, audioInputTokens: { int: true, min: 0, ask: 'Audio input tokens per month (realtime / audio models)?' }, audioOutputTokens: { int: true, min: 0, ask: 'Audio output tokens per month?' }, imageInputTokens: { int: true, min: 0, ask: 'Image input tokens per month?' }, imageOutputTokens: { int: true, min: 0, ask: 'Image output tokens per month (image generation)?' }, videoSeconds: { int: true, min: 0, ask: 'Sora: seconds of video generated per month?' }, imageCount: { int: true, min: 0, ask: 'DALL-E 3: images generated per month?' }, imageQuality: { def: 'standard', enum: ['standard', 'hd'], ask: 'DALL-E 3 quality: standard or hd?' }, imageSize: { def: '1024x1024', enum: ['1024x1024', '1792x1024', '1024x1792'], ask: 'DALL-E 3 image size (1024x1024 is standard resolution; the others are high resolution)?' }, codeInterpreterSessions: { int: true, min: 0, ask: 'Code interpreter sessions per month?' }, fileSearchCalls: { int: true, min: 0, ask: 'File search tool calls per month?' }, fileSearchStorageGBDays: { min: 0, ask: 'File search vector storage in GB-days per month (GB stored x days)?' } } },
  meter: { label: 'Any other meter (escape hatch)', fields: { filter: { req: true, ask: 'Exact {serviceName, productName, skuName, meterName}; find with `azp search`.' }, quantity: { req: true, min: 0, ask: 'Amount in the meter\'s own unit (GB, operations, ...). For an hourly meter it is the number of instances.' }, hours: { min: 0, ask: 'Hourly meters only: hours each instance runs in the month (730 = all month). Refused for per-GB / per-operation meters.' }, desc: {}, group: {}, unit: {} } }
};

// When running inside GitHub Copilot CLI, verify customerSaid quotes against what the user
// actually typed in this session. Stops models from inventing the person's answers.
function sessionLog() {
  const sid = process.env.COPILOT_AGENT_SESSION_ID;
  if (!sid) return null;
  const home = process.env.COPILOT_HOME || require('path').join(require('os').homedir(), '.copilot');
  const f = require('path').join(home, 'session-state', sid, 'events.jsonl');
  try { return require('fs').readFileSync(f, 'utf8'); } catch (_) { return null; }
}

const norm = s => String(s || '').toLowerCase().replace(/\u00d7/g, 'x').replace(/[\u2018\u2019\u201C\u201D]/g, '').replace(/[^a-z0-9.%]+/g, ' ').replace(/\s+/g, ' ').trim();

// The person must have seen the exact readback for this spec and replied to it.
function confirmationErrors(spec) {
  const txt = sessionLog(); if (txt == null) return [];
  const { readback } = require('./readback');
  const rb = readback(spec);
  const events = txt.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const raw = rb.text.split('\n').slice(1, -1).map(l => l.replace(/^\s*-\s*/, '').trim());
  const lines = raw.map(norm);
  const code = norm(rb.code);
  const how = `Run \`azp readback <spec>\`, paste its "text" to the person unchanged (formatting such as bold is fine), and ask them to confirm. Build only after they reply. If they correct anything, update the spec and show the new readback.`;
  let best = null, shown = -1;
  events.forEach((e, i) => {
    if (e.type !== 'assistant.message') return;
    const c = norm(e.data && e.data.content);
    if (!c.includes(code)) return;
    const miss = raw.filter((l, j) => !c.includes(lines[j]));
    if (!miss.length) shown = i; else if (!best || miss.length < best.length) best = miss;
  });
  if (shown < 0) {
    if (best) return [`The readback shown for check ${rb.code} does not match the engine's text. These lines are missing or changed: ${best.slice(0, 4).map(l => `"${l}"`).join('; ')}. ${how}`];
    return [`The person has not seen the readback for this spec (check ${rb.code}). ${how}`];
  }
  const reply = events.slice(shown + 1).find(e => e.type === 'user.message' && e.data && typeof e.data.content === 'string' && !e.data.source && !e.data.content.startsWith('<skill-context'));
  if (!reply) return [`The person has not replied to the readback (check ${rb.code}) yet. Wait for their answer before building.`];
  if (/^\s*(no\b|nope|not (quite|right|correct)|wrong|incorrect|that'?s not|actually\b)/i.test(reply.data.content)) return [`The person corrected the readback (check ${rb.code}): "${reply.data.content.slice(0, 160)}". Update the spec, then show the new readback.`];
  return [];
}

// The model actually answering in this Copilot session (each response records it; "auto" resolves
// to a concrete model), and how it performed in testing.
function modelStatus() {
  const txt = sessionLog();
  let model = null;
  const all = new Set();
  if (txt) {
    for (const l of txt.split(/\r?\n/)) {
      if (!/"(assistant\.message|session\.model_change|session\.start)"/.test(l)) continue;
      try {
        const e = JSON.parse(l); const d = e.data || {};
        const m = e.type === 'assistant.message' ? d.model : e.type === 'session.model_change' ? d.newModel : d.selectedModel;
        if (m && m !== 'auto') { all.add(m); if (e.type === 'assistant.message' && !d.parentToolCallId) model = model || m; }
      } catch (_) { }
    }
  }
  const M = require('../../catalog/models.json');
  // Any not-recommended model anywhere in the session counts: a later message cannot clear it.
  const bad = [...all].find(m => M.notRecommended[m]);
  if (bad) model = bad;
  else if (all.size) model = [...all].find(m => !M.recommended[m]) || [...all][0];
  const rec = Object.keys(M.recommended);
  const list = rec.join(', ');
  if (!model) return { model: null, status: 'unknown', notice: null, recommended: rec };
  if (M.recommended[model]) return { model, status: 'recommended', notice: null, recommended: rec };
  if (M.acceptable[model]) return { model, status: 'acceptable', notice: `This estimate is being prepared with ${model}. It works with this skill but was less consistent in testing (${M.acceptable[model]}). For the most reliable results, switch to one of: ${list} (in GitHub Copilot, use /model).`, recommended: rec };
  if (M.notRecommended[model]) return { model, status: 'not-recommended', notice: `This estimate is being prepared with ${model}, which is NOT recommended for this skill. ${M.notRecommended[model]} Please switch to one of: ${list} (in GitHub Copilot, use /model), then start again.`, recommended: rec };
  return { model, status: 'untested', notice: `This estimate is being prepared with ${model}, which has not been tested with this skill. The prices come from the pricing engine either way, but the conversation may be less reliable. Tested and recommended: ${list} (in GitHub Copilot, use /model).`, recommended: rec };
}

function userMessages() {
  const txt = sessionLog();
  if (txt == null) return null;
  const msgs = [];
  let tampered = false;
  // Copilot writes every event with a unique id, a timestamp and a parentId pointing to an earlier
  // event. A real message from the person always starts a turn (its parent is the system message),
  // carries Copilot's delivery fields, and arrives in time order. Hand-written lines fail these.
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const seen = new Map();
  let lastTs = '';
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch (_) { if (i < lines.length - 1) tampered = true; return; }
    if (!e.id || !e.timestamp || seen.has(e.id) || (seen.size && !seen.has(e.parentId))) tampered = true;
    if (e.timestamp < lastTs) tampered = true; else lastTs = e.timestamp;
    if (e.type === 'user.message') {
      const d = e.data || {};
      if (!d.interactionId) tampered = true;
      if (!d.source && (seen.get(e.parentId) !== 'system.message' || !('delivery' in d) || !('supportedNativeDocumentMimeTypes' in d))) tampered = true;
    }
    if (e.id) seen.set(e.id, e.type);
  });
  for (const line of lines) {
    if (!line.includes('"user.message"')) continue;
    try {
      const j = JSON.parse(line); const d = j.data || {}; const c = d.content;
      if (typeof c !== 'string' || c.startsWith('<skill-context') || d.source) continue;
      // Copilot records what the person typed twice. If they disagree, the log was edited.
      if (typeof d.transformedContent === 'string' && !d.transformedContent.replace(/\s+/g, ' ').includes(c.trim().replace(/\s+/g, ' '))) tampered = true;
      msgs.push(typeof d.transformedContent === 'string' ? d.transformedContent.replace(/<current_datetime>[\s\S]*?<\/current_datetime>|<system_reminder>[\s\S]*?<\/system_reminder>/g, '') : c);
    } catch (_) { }
  }
  if (tampered) return '\u0000TAMPERED';
  return msgs.join('\n').toLowerCase();
}

// True if a quote is traceable to what the person typed (or if not running inside Copilot).
// A quote that is literally what the person typed is always theirs, even if it says "default".
function quoteVerbatim(q) {
  const user = userMessages();
  if (user == null || user === '\u0000TAMPERED') return false;
  const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  const qq = n(q);
  return qq.split(' ').length >= 3 && n(user).includes(qq);
}

function quoteGrounded(q) {
  const user = userMessages();
  if (user == null) return !(process.env.COPILOT_AGENT_SESSION_ID || underCopilot());
  if (user === '\u0000TAMPERED') return false;
  const toks = (String(q || '').toLowerCase().match(/[a-z]{4,}|\d+/g) || []).filter(t => !['that', 'with', 'have', 'from', 'this', 'what', 'they', 'your', 'about'].includes(t));
  return toks.length >= 2 && toks.filter(t => user.includes(t)).length / toks.length >= 0.6;
}

// True if this process runs under GitHub Copilot CLI, judged from the process tree rather than
// environment variables (which a model can delete).
function underCopilot() {
  if (underCopilot.v !== undefined) return underCopilot.v;
  let v = false;
  try {
    const { execSync, execFileSync } = require('child_process');
    const procs = new Map();
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      for (const l of out.split(/\r?\n/)) { const [p, pp, n] = l.split('|'); if (p) procs.set(Number(p), { pp: Number(pp), n: n || '' }); }
    } else {
      const out = execSync('ps -A -o pid=,ppid=,comm=', { encoding: 'utf8', timeout: 15000 });
      for (const l of out.split(/\n/)) { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); if (m) procs.set(Number(m[1]), { pp: Number(m[2]), n: m[3] }); }
    }
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid && procs.has(pid); i++) { const p = procs.get(pid); if (/copilot/i.test(p.n)) { v = true; break; } pid = p.pp; }
  } catch (_) { }
  return (underCopilot.v = v);
}

function groundingErrors(spec) {
  const inCopilot = !!process.env.COPILOT_AGENT_SESSION_ID || underCopilot();
  const user = userMessages();
  if (user == null) {
    groundingErrors.status = 'unverified';
    // Inside Copilot the session log must be readable; a missing log means the check was bypassed.
    return inCopilot ? ['Cannot read this conversation to verify the person\'s answers. Do not change environment variables or files; run the build normally.'] : [];
  }
  groundingErrors.status = 'verified';
  if (user === '\u0000TAMPERED') { groundingErrors.status = 'tampered'; return ['The conversation log does not match what the person typed. Estimates can only be built from the person\'s real answers.']; }
  const errs = [];
  const said = spec.customerSaid || {};
  for (const k of ['region', 'discount', 'requirements']) {
    const toks = (String(said[k] || '').toLowerCase().match(/[a-z]{4,}|\d+/g) || []).filter(t => !['that', 'with', 'have', 'from', 'this', 'what', 'they', 'your', 'about'].includes(t));
    if (!toks.length) continue;
    const hit = toks.filter(t => user.includes(t)).length / toks.length;
    if (hit < 0.6) errs.push(`"customerSaid.${k}" ("${said[k]}") does not match anything the person typed in this conversation. Do not invent their answers: ask them.`);
  }
  const pct = Number(spec.discountPct || 0);
  if (pct > 0 && !new RegExp(`\\b${String(pct).replace('.', '\\.')}\\s*(%|percent|pct)|\\b${String(pct).replace('.', '\\.')}\\b[^.\\n]{0,25}\\b(off|discount)`).test(user)) errs.push(`discountPct ${pct} was never stated by the person as a percentage discount. Ask them for their discount.`);
  if (pct === 0 && !/\b(no|none|don't|dont|do not|without|zero|0%|not have|n't have)\b[^.\n]{0,40}\bdiscounts?\b|\bdiscounts?\b[^.\n]{0,30}\b(none|no|zero|0%)\b|\blist price\b/.test(user)) errs.push('discountPct is 0 but the person never said they have no discount. Ask them.');
  // Region: the region itself, or a location the person named, must appear in what they typed.
  const REG = require('../../catalog/regions.json');
  const code = String(spec.region || '').toLowerCase().replace(/\s+/g, '');
  const name = (Object.entries(REG).find(([c, n]) => c === code || n.toLowerCase().replace(/\s+/g, '') === code) || [code, code])[1].toLowerCase();
  const regionStated = user.includes(name) || user.includes(code) || user.replace(/\s+/g, '').includes(name.replace(/\s+/g, ''));
  const deferred = /\b(recommend|suggest|you pick|don't know|dont know|not sure|whatever)\b/.test(user) && /\brecommend|suggest/i.test(String(said.region || ''));
  const placeWords = (String(said.region || '').match(/\b[A-Z][a-z]{3,}\b/g) || []).filter(w => user.includes(w.toLowerCase()));
  if (!regionStated && !deferred && !placeWords.length) errs.push(`The person never named ${name} or a location that maps to it. Ask which region (or where their users are).`);
  // The quoted region must not name a different region than the one priced.
  const saidR = String(said.region || '').toLowerCase();
  const named = Object.values(REG).map(n => n.toLowerCase()).filter(n => new RegExp(`(^|[^a-z])${n.replace(/\s+/g, '\\s*')}([^a-z]|$)`).test(saidR)).sort((a, b) => b.length - a.length)[0];
  if (named && named !== name) errs.push(`The person said "${said.region}" but the spec prices ${name}. Use the region they asked for.`);
  return errs;
}

function validateSpec(spec, opts = {}) {
  const errs = [];
  errs.push(...groundingErrors(spec));
  if (groundingErrors.status === 'verified' && opts.confirm !== false) errs.push(...confirmationErrors(spec));
  if (!spec.region) errs.push('Missing "region".');
  if (spec.discountPct == null) errs.push('Missing "discountPct" (use 0 if the customer has no discount).');
  else if (typeof spec.discountPct !== 'number' || !Number.isFinite(spec.discountPct) || spec.discountPct < 0 || spec.discountPct >= 100) errs.push('"discountPct" must be a number from 0 to 99.99 (for example 16 for 16 percent, 0 for none).');
  const said = spec.customerSaid || {};
  const fake = /assum|not (been )?(specified|provided|stated|given|mentioned)|unspecified|default|\bn\/a\b|\bunknown\b|\btbd\b|placeholder/i;
  for (const k of ['region', 'discount', 'requirements']) if (said[k] && fake.test(String(said[k])) && !quoteVerbatim(said[k])) errs.push(`"customerSaid.${k}" is an assumption, not the person's words ("${said[k]}"). STOP and ask them.`);
  if (!said.region || String(said.region).trim().length < 3) errs.push('Missing "customerSaid.region": quote the person\'s own words about the region. If they have not told you, STOP and ask them; do not assume a region.');
  if (!said.discount || String(said.discount).trim().length < 2) errs.push('Missing "customerSaid.discount": quote the person\'s own words about their discount (for example "16% off list" or "no discount"). If they have not told you, STOP and ask them; do not assume.');
  if (!said.requirements || String(said.requirements).trim().length < 3) errs.push('Missing "customerSaid.requirements": quote what the person told you about size and usage (CPU/memory, capacity, volumes, hours). If they have not told you, STOP and ask them.');
  if (!Array.isArray(spec.options) || !spec.options.length) errs.push('Missing "options" array.');
  const contexts = [['context', spec.context], ...(spec.options || []).map((o, i) => [`options[${i}].context`, o.context])];
  for (const [prefix, context] of contexts) {
    if (context == null) continue;
    if (typeof context !== 'object' || Array.isArray(context)) { errs.push(`${prefix} must be an object.`); continue; }
    for (const [k, v] of Object.entries(context)) {
      if (!CONTEXT[k]) errs.push(`${prefix}: unknown field "${k}". Known: ${Object.keys(CONTEXT).filter(x => !CONTEXT[x].internal).join(', ')}.`);
      else if (typeof v !== 'boolean') errs.push(`${prefix}.${k} must be true or false.`);
    }
  }
  (spec.options || []).forEach((o, i) => {
    if (o.phase != null && (typeof o.phase !== 'string' || !o.phase.trim())) errs.push(`options[${i}].phase must be a non-empty phase label.`);
  });
  (spec.options || []).forEach((o, i) => (o.components || []).forEach((c, j) => {
    if (c.type === 'vm' && c.sku) {
      const { lifecycle, explain } = require('./lifecycle');
      if (!lifecycle(c.sku).modern) errs.push(`options[${i}].components[${j}]: ${explain(c.sku)} Do not price it. Run \`azp vm-suggest\` with the same vCPU and memory, price that size instead, add {"requested": "${c.sku}", "priced": "<new size>"} to spec.replacedSizes, and explain this to the person with the references.`);
    }
  }));
  for (const r of spec.replacedSizes || []) {
    const { lifecycle } = require('./lifecycle');
    if (!r || !r.requested || !r.priced) errs.push('replacedSizes entries need "requested" and "priced".');
    else if (lifecycle(r.requested).modern) errs.push(`replacedSizes: ${r.requested} is a Current or Extended size; it does not need replacing.`);
    else if (!lifecycle(r.priced).modern) errs.push(`replacedSizes: ${r.priced} is also End of Life; choose a Current or Extended size from vm-suggest.`);
  }
  (spec.options || []).forEach((o, i) => (o.components || []).forEach((c, j) => {
    const s = S[c.type];
    if (!s) { errs.push(`options[${i}].components[${j}]: ` + (require('./excluded').excludedMessage(c.type) || `unknown type "${c.type}".`)); return; }
    for (const [k, f] of Object.entries(s.fields)) {
      if (f.req && c[k] == null && !(k === 'gbSeconds')) errs.push(`options[${i}].components[${j}] (${c.type}): missing "${k}".`);
      if (f.enum && c[k] != null && !f.enum.includes(c[k])) errs.push(`options[${i}].components[${j}] (${c.type}): "${k}" must be one of ${f.enum.join(', ')}.`);
    }
    for (const k of Object.keys(c)) if (!['type', 'label'].includes(k) && !s.fields[k]) errs.push(`options[${i}].components[${j}] (${c.type}): unknown field "${k}".`);
    for (const m of require('./estimate').numericErrors(c)) errs.push(`options[${i}].components[${j}] (${c.type}): ${m}`);
  }));
  return errs;
}

// Workload context. Ask a context question only when one of its services is in the estimate,
// in plain words, with the default offered. Answers go in spec.context and appear in the readback.
const CONTEXT = {
  production: { ask: 'Is this for production (real users or business processes), or for development and testing?', type: 'boolean', when: 'always' },
  internetFacing: { ask: 'Will people reach it from the internet, or only from inside your network?', type: 'boolean', when: 'any web, app, VM or container service' },
  interruptible: { ask: 'If Azure needed the capacity back, could this work be stopped and restarted later without harm (for example batch jobs or test machines)?', type: 'boolean', def: false, services: ['vm', 'aks'] },
  steadyUsage: { ask: 'Will you keep running roughly this much for a year or longer?', type: 'boolean', services: ['vm', 'aks', 'app-service', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files', 'log-analytics'] },
  idlePeriods: { ask: 'Is it idle for long stretches, such as nights or weekends?', type: 'boolean', def: false, services: ['sql-database', 'postgres', 'mysql', 'cosmos', 'vm'] },
  zoneResilience: { ask: 'Must it keep running if one Azure datacenter in the region goes down?', type: 'boolean', services: ['vm', 'disk', 'aks', 'app-service', 'container-apps', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files', 'load-balancer', 'app-gateway'] },
  privateOnly: { ask: 'Should it be reachable only from your private network, with no public access?', type: 'boolean', def: false, services: ['vm', 'app-service', 'functions', 'container-apps', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files'] },
  multiRegionUsers: { ask: 'Are your users spread across several countries or continents?', type: 'boolean', def: false, services: ['app-service', 'app-gateway', 'load-balancer', 'container-apps', 'cosmos', 'vm'] },
  frontDoor: { ask: 'internal: set true when the design already includes Azure Front Door', type: 'boolean', internal: true }
};

// Built-in types, then every service module in ./services.
const BUILTIN_FAMILY = { vm: 'compute', disk: 'storage', 'public-ip': 'networking', bandwidth: 'networking', 'load-balancer': 'networking', 'app-gateway': 'networking', aks: 'containers', 'app-service': 'web', functions: 'web', 'container-apps': 'containers', 'sql-database': 'databases', 'sql-mi': 'databases', postgres: 'databases', mysql: 'databases', cosmos: 'databases', blob: 'storage', files: 'storage', 'log-analytics': 'monitoring', openai: 'ai', meter: 'other' };
for (const [t, f] of Object.entries(BUILTIN_FAMILY)) if (S[t]) S[t].family = f;
const BUILTIN_KEYWORDS = { vm: ['virtual machine', 'server', 'vm', 'compute', 'windows', 'linux', 'red hat', 'scale set'], disk: ['managed disk', 'ssd', 'hdd', 'storage', 'volume'], 'public-ip': ['public ip', 'ip address'], bandwidth: ['egress', 'data transfer', 'internet', 'bandwidth', 'outbound'], 'load-balancer': ['load balancer', 'lb'], 'app-gateway': ['application gateway', 'waf', 'web application firewall'], aks: ['kubernetes', 'aks', 'containers', 'cluster'], 'app-service': ['web app', 'website', 'app service', 'api app'], functions: ['functions', 'serverless'], 'container-apps': ['container apps', 'containers', 'microservices'], 'sql-database': ['sql database', 'azure sql', 'database'], 'sql-mi': ['sql managed instance', 'sql server'], postgres: ['postgresql', 'postgres', 'database'], mysql: ['mysql', 'database'], cosmos: ['cosmos db', 'nosql', 'document database'], blob: ['blob', 'object storage', 'storage account', 'archive', 'backup files'], files: ['file shares', 'smb', 'nfs', 'azure files'], 'log-analytics': ['logs', 'log analytics', 'monitoring', 'azure monitor'], openai: ['openai', 'gpt', 'llm', 'ai model', 'chatbot', 'tokens'], meter: ['other', 'generic'] };
for (const [t, k] of Object.entries(BUILTIN_KEYWORDS)) if (S[t]) S[t].keywords = k;
for (const [t, s] of Object.entries(require('./services'))) {
  if (S[t]) throw new Error(`Service module "${t}" duplicates a built-in component type.`);
  S[t] = { label: s.label, family: s.family, keywords: s.keywords || [], fields: s.fields };
  for (const k of s.context || []) {
    if (!CONTEXT[k]) throw new Error(`Service module "${t}": unknown context "${k}".`);
    if (CONTEXT[k].services && !CONTEXT[k].services.includes(t)) CONTEXT[k].services.push(t);
  }
}

module.exports = { SCHEMA: S, CONTEXT, validateSpec, quoteGrounded, modelStatus, verificationStatus: () => groundingErrors.status || 'unverified' };
