CREATE TABLE `daily_totals` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`runner` text NOT NULL,
	`jobs` integer NOT NULL,
	`first_attempt_jobs` integer NOT NULL,
	`first_attempt_passed` integer NOT NULL,
	`failed_jobs` integer NOT NULL,
	`flakes` integer NOT NULL,
	`seconds` integer NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `day`, `provider`, `runner`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `flake_records` (
	`org_id` integer NOT NULL,
	`repo` text NOT NULL,
	`workflow` text NOT NULL,
	`job_name` text NOT NULL,
	`commit_sha` text NOT NULL,
	`day` text NOT NULL,
	`failed_url` text NOT NULL,
	`passed_url` text NOT NULL,
	`issue_ids` text NOT NULL,
	`provider` text NOT NULL,
	`runner` text NOT NULL,
	`is_smoke` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`org_id`, `repo`, `workflow`, `job_name`, `commit_sha`),
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
