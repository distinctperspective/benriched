import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { classifyTier } from '../src/lib/tier.js';

async function backfillTiers() {
  console.log('🚀 Starting tier backfill for existing titles...\n');

  // Get all titles without tier classification
  const { data: titles, error } = await supabase
    .from('titles')
    .select('id, title, tier, normalized_title')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('❌ Error fetching titles:', error);
    process.exit(1);
  }

  if (!titles || titles.length === 0) {
    console.log('✅ No titles found in database');
    return;
  }

  console.log(`📊 Found ${titles.length} titles in database`);
  
  const titlesNeedingClassification = titles.filter(t => !t.tier || !t.normalized_title);
  const titlesAlreadyClassified = titles.length - titlesNeedingClassification.length;

  console.log(`   ✅ Already classified: ${titlesAlreadyClassified}`);
  console.log(`   🔄 Need classification: ${titlesNeedingClassification.length}\n`);

  if (titlesNeedingClassification.length === 0) {
    console.log('🎉 All titles already have tier classification!');
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  let totalCost = 0;

  for (let i = 0; i < titlesNeedingClassification.length; i++) {
    const title = titlesNeedingClassification[i];
    const progress = `[${i + 1}/${titlesNeedingClassification.length}]`;

    try {
      console.log(`${progress} Processing: "${title.title}"`);
      
      // Classify tier
      const tierResult = await classifyTier(title.title);
      
      // Update database
      const { error: updateError } = await supabase
        .from('titles')
        .update({
          tier: tierResult.tierLabel,
          normalized_title: tierResult.normalizedTitle
        })
        .eq('id', title.id);

      if (updateError) {
        console.error(`   ❌ Failed to update: ${updateError.message}`);
        errorCount++;
      } else {
        console.log(`   ✅ Saved: ${tierResult.tierLabel} - "${tierResult.normalizedTitle}"`);
        successCount++;
        if (tierResult.cost) {
          totalCost += tierResult.cost.costUsd;
        }
      }

      // Small delay to avoid rate limits
      if (i < titlesNeedingClassification.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      errorCount++;
    }

    console.log(''); // Empty line for readability
  }

  console.log('\n📈 Backfill Summary:');
  console.log(`   ✅ Successfully classified: ${successCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
  console.log(`   💰 Total cost: $${totalCost.toFixed(4)}`);
  console.log(`   📊 Total titles in database: ${titles.length}`);
  console.log(`   🎯 Completion rate: ${((successCount / titlesNeedingClassification.length) * 100).toFixed(1)}%`);
}

// Run the backfill
backfillTiers()
  .then(() => {
    console.log('\n✅ Backfill complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  });
