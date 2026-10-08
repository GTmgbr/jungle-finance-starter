#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true
DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true
MAIN_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}\n' "$DLQ_ARN" > /tmp/wager-redrive.json
awslocal sqs set-queue-attributes --queue-url "$MAIN_URL" --attributes file:///tmp/wager-redrive.json
awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true
