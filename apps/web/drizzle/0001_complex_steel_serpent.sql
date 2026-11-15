CREATE TABLE `attempts` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt` integer NOT NULL,
	`conclusion` text,
	`created_at` text NOT NULL,
	`latest_attempt` integer NOT NULL,
	`job_count` integer NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `run_id`, `run_attempt`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `compares` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`base` text NOT NULL,
	`head` text NOT NULL,
	`files` text,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `base`, `head`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `excerpts` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`job_id` integer NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`excerpt` text,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `job_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `failures` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`job_id` integer NOT NULL,
	`url` text NOT NULL,
	`signature` text NOT NULL,
	`issue_id` text NOT NULL,
	`file` text,
	`title` text,
	`location` text,
	`error_line` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `job_id`, `signature`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `failures_by_issue` ON `failures` (`org_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`org_id` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`signatures` text NOT NULL,
	`explanation` text,
	`edited` integer DEFAULT false NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`org_id` integer NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt` integer NOT NULL,
	`job_id` integer NOT NULL,
	`workflow` text NOT NULL,
	`job_name` text NOT NULL,
	`url` text NOT NULL,
	`commit_sha` text NOT NULL,
	`branch` text NOT NULL,
	`pr_number` integer,
	`runner` text NOT NULL,
	`runner_name` text NOT NULL,
	`conclusion` text,
	`started_at` text,
	`completed_at` text,
	`steps` text NOT NULL,
	`annotations` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `provider`, `repo`, `run_id`, `run_attempt`, `job_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_by_repo` ON `jobs` (`org_id`,`repo`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`job_id` integer NOT NULL,
	`issue_id` text NOT NULL,
	`outcome` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `job_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` integer PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisations_login_unique` ON `organisations` (`login`);--> statement-breakpoint
CREATE TABLE `repos` (
	`org_id` integer NOT NULL,
	`name` text NOT NULL,
	`added_at` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `name`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
